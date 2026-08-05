using System.Globalization;
using System.Security.Cryptography;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.WebUtilities;
using StackExchange.Redis;

namespace Axis.ReferenceProduct.Bff;

internal sealed class RedisTicketStore(
    IConnectionMultiplexer redis,
    IDataProtectionProvider dataProtectionProvider) : ITicketStore
{
    internal const string AbsoluteExpiryProperty = "axis-reference-product:absolute-expires-at";
    private const string KeyPrefix = "axis-reference-product:browser-session:";
    private readonly IDataProtector protector = dataProtectionProvider.CreateProtector(
        "Axis.ReferenceProduct.Bff",
        "BrowserSessionTicket",
        "v1");

    public Task<string> StoreAsync(AuthenticationTicket ticket) => StoreAsync(ticket, CancellationToken.None);

    public async Task<string> StoreAsync(AuthenticationTicket ticket, CancellationToken cancellationToken)
    {
        byte[] payload = protector.Protect(TicketSerializer.Default.Serialize(ticket));
        for (int attempt = 0; attempt < 3; attempt++)
        {
            string id = Microsoft.AspNetCore.WebUtilities.Base64UrlTextEncoder.Encode(
                RandomNumberGenerator.GetBytes(32));
            bool stored = await redis.GetDatabase().StringSetAsync(
                    KeyPrefix + id,
                    payload,
                    RemainingLifetime(ticket),
                    When.NotExists)
                .WaitAsync(cancellationToken);
            if (stored) return id;
        }
        throw new InvalidOperationException("Could not allocate a unique BFF session identifier.");
    }

    public Task<string> StoreAsync(AuthenticationTicket ticket, HttpContext context, CancellationToken cancellationToken) =>
        StoreAsync(ticket, cancellationToken);

    public Task RenewAsync(string key, AuthenticationTicket ticket) => RenewAsync(key, ticket, CancellationToken.None);

    public async Task RenewAsync(string key, AuthenticationTicket ticket, CancellationToken cancellationToken)
    {
        bool renewed = await redis.GetDatabase().StringSetAsync(
                KeyPrefix + key,
                protector.Protect(TicketSerializer.Default.Serialize(ticket)),
                RemainingLifetime(ticket),
                When.Exists)
            .WaitAsync(cancellationToken);
        if (!renewed) throw new InvalidOperationException("The BFF session no longer exists.");
    }

    public Task RenewAsync(string key, AuthenticationTicket ticket, HttpContext context, CancellationToken cancellationToken) =>
        RenewAsync(key, ticket, cancellationToken);

    public Task<AuthenticationTicket?> RetrieveAsync(string key) => RetrieveAsync(key, CancellationToken.None);

    public async Task<AuthenticationTicket?> RetrieveAsync(string key, CancellationToken cancellationToken)
    {
        RedisValue value = await redis.GetDatabase().StringGetAsync(KeyPrefix + key).WaitAsync(cancellationToken);
        if (value.IsNull) return null;
        try
        {
            return TicketSerializer.Default.Deserialize(protector.Unprotect((byte[])value!));
        }
        catch (CryptographicException)
        {
            await RemoveAsync(key, cancellationToken);
            return null;
        }
    }

    public Task<AuthenticationTicket?> RetrieveAsync(string key, HttpContext context, CancellationToken cancellationToken) =>
        RetrieveAsync(key, cancellationToken);

    public Task RemoveAsync(string key) => RemoveAsync(key, CancellationToken.None);

    public async Task RemoveAsync(string key, CancellationToken cancellationToken) =>
        await redis.GetDatabase().KeyDeleteAsync(KeyPrefix + key).WaitAsync(cancellationToken);

    public Task RemoveAsync(string key, HttpContext context, CancellationToken cancellationToken) =>
        RemoveAsync(key, cancellationToken);

    private static TimeSpan RemainingLifetime(AuthenticationTicket ticket)
    {
        DateTimeOffset? expiry = ticket.Properties.ExpiresUtc;
        if (ticket.Properties.Items.TryGetValue(AbsoluteExpiryProperty, out string? raw) &&
            DateTimeOffset.TryParseExact(raw, "O", CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out DateTimeOffset absolute) &&
            (expiry is null || absolute < expiry))
        {
            expiry = absolute;
        }
        if (expiry is null || expiry <= DateTimeOffset.UtcNow)
            throw new InvalidOperationException("The BFF session ticket has no valid remaining lifetime.");
        return expiry.Value - DateTimeOffset.UtcNow;
    }
}

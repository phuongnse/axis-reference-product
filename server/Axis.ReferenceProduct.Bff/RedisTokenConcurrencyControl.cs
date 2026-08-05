using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Duende.AccessTokenManagement;
using Duende.AccessTokenManagement.OpenIdConnect;
using Microsoft.AspNetCore.DataProtection;
using StackExchange.Redis;

namespace Axis.ReferenceProduct.Bff;

internal sealed class RedisTokenConcurrencyControl(
    IConnectionMultiplexer redis,
    IHttpContextAccessor httpContextAccessor,
    IDataProtectionProvider dataProtectionProvider) : IUserTokenRequestConcurrencyControl
{
    private static readonly TimeSpan LockLifetime = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan ResultLifetime = TimeSpan.FromSeconds(30);
    private readonly IDataProtector protector = dataProtectionProvider.CreateProtector(
        "Axis.ReferenceProduct.Bff",
        "DistributedTokenRefreshResult",
        "v1");

    public async Task<TokenResult<UserToken>> ExecuteWithConcurrencyControlAsync(
        UserRefreshToken key,
        Func<Task<TokenResult<UserToken>>> tokenRetriever,
        CancellationToken ct = default)
    {
        string sessionId = httpContextAccessor.HttpContext?.User.FindFirstValue("axis_reference_product_session_id")
            ?? throw new InvalidOperationException("The authenticated BFF session has no concurrency identifier.");
        string refreshFingerprint = Convert.ToHexStringLower(SHA256.HashData(
            Encoding.UTF8.GetBytes(key.RefreshToken.ToString())));
        string lockKey = $"axis-reference-product:token-refresh-lock:{sessionId}";
        string resultKey = $"axis-reference-product:token-refresh-result:{sessionId}:{refreshFingerprint}";
        string owner = Guid.NewGuid().ToString("N");
        IDatabase database = redis.GetDatabase();
        DateTimeOffset deadline = DateTimeOffset.UtcNow.AddSeconds(15);

        while (!await database.StringSetAsync(lockKey, owner, LockLifetime, When.NotExists).WaitAsync(ct))
        {
            if (DateTimeOffset.UtcNow >= deadline)
                throw new TimeoutException("Timed out waiting for the distributed token refresh lock.");
            await Task.Delay(TimeSpan.FromMilliseconds(50), ct);
        }

        try
        {
            RedisValue cached = await database.StringGetAsync(resultKey).WaitAsync(ct);
            if (!cached.IsNull)
            {
                byte[] payload = protector.Unprotect((byte[])cached!);
                return TokenResult.Success(
                    JsonSerializer.Deserialize<UserToken>(payload)
                    ?? throw new InvalidOperationException("The distributed token refresh result is invalid."));
            }

            TokenResult<UserToken> result = await tokenRetriever();
            if (result.Succeeded)
            {
                byte[] serialized = protector.Protect(JsonSerializer.SerializeToUtf8Bytes(result.Token));
                await database.StringSetAsync(resultKey, serialized, ResultLifetime).WaitAsync(ct);
            }
            return result;
        }
        finally
        {
            await database.ScriptEvaluateAsync(
                "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
                [new RedisKey(lockKey)],
                [new RedisValue(owner)]).WaitAsync(CancellationToken.None);
        }
    }

}

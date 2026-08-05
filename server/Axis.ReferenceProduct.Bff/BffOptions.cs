namespace Axis.ReferenceProduct.Bff;

internal sealed record BffOptions(
    Uri Authority,
    Uri ApiBaseUrl,
    string ClientId,
    string ClientSecret,
    string RedisConnectionString,
    TimeSpan IdleLifetime,
    TimeSpan AbsoluteLifetime,
    string? BackchannelHost,
    int? BackchannelPort)
{
    public static BffOptions Load(IConfiguration configuration)
    {
        Uri authority = RequiredHttpsUri(configuration["Authentication:Authority"], "Authentication:Authority");
        Uri apiBaseUrl = RequiredHttpsUri(configuration["Axis:ApiBaseUrl"], "Axis:ApiBaseUrl");
        string clientId = Required(configuration["Authentication:ClientId"], "Authentication:ClientId");
        string clientSecret = Required(configuration["Authentication:ClientSecret"], "Authentication:ClientSecret");
        if (clientSecret.Length < 32)
            throw new InvalidOperationException("Authentication:ClientSecret must contain at least 32 characters.");
        string redis = Required(configuration.GetConnectionString("Redis"), "ConnectionStrings:Redis");
        int idleMinutes = configuration.GetValue("Session:IdleMinutes", 30);
        int absoluteHours = configuration.GetValue("Session:AbsoluteHours", 8);
        if (idleMinutes <= 0 || absoluteHours <= 0 || TimeSpan.FromMinutes(idleMinutes) > TimeSpan.FromHours(absoluteHours))
            throw new InvalidOperationException("Session lifetime configuration is invalid.");

        string? backchannelHost = configuration["Authentication:Backchannel:ConnectHost"];
        int? backchannelPort = configuration.GetValue<int?>("Authentication:Backchannel:ConnectPort");
        if (string.IsNullOrWhiteSpace(backchannelHost) != (backchannelPort is null))
            throw new InvalidOperationException("Authentication backchannel host and port must be configured together.");
        if (backchannelPort is <= 0 or > 65535)
            throw new InvalidOperationException("Authentication backchannel port is invalid.");

        return new BffOptions(
            authority,
            apiBaseUrl,
            clientId,
            clientSecret,
            redis,
            TimeSpan.FromMinutes(idleMinutes),
            TimeSpan.FromHours(absoluteHours),
            backchannelHost,
            backchannelPort);
    }

    private static Uri RequiredHttpsUri(string? value, string path)
    {
        string canonical = Required(value, path);
        if (!Uri.TryCreate(canonical, UriKind.Absolute, out Uri? uri) ||
            uri.Scheme != Uri.UriSchemeHttps ||
            !string.IsNullOrEmpty(uri.UserInfo) ||
            !string.IsNullOrEmpty(uri.Query) ||
            !string.IsNullOrEmpty(uri.Fragment))
        {
            throw new InvalidOperationException($"{path} must be an HTTPS origin or base URL.");
        }
        return uri;
    }

    private static string Required(string? value, string path)
    {
        if (string.IsNullOrWhiteSpace(value) || value != value.Trim())
            throw new InvalidOperationException($"{path} is required and must be canonical.");
        return value;
    }
}

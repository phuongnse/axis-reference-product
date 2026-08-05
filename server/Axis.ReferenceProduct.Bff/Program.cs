using System.Globalization;
using System.Security.Claims;
using System.Security.Cryptography.X509Certificates;
using Axis.ReferenceProduct.Bff;
using Duende.AccessTokenManagement.OpenIdConnect;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authentication.OpenIdConnect;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.IdentityModel.Protocols.OpenIdConnect;
using Microsoft.IdentityModel.Tokens;
using StackExchange.Redis;
using Yarp.ReverseProxy.Forwarder;

WebApplicationBuilder builder = WebApplication.CreateBuilder(args);
BffOptions settings = BffOptions.Load(builder.Configuration);
const string AntiforgeryFormFieldName = "__RequestVerificationToken";
builder.Services.AddSingleton(settings);

IConnectionMultiplexer redis = ConnectionMultiplexer.Connect(settings.RedisConnectionString);
builder.Services.AddSingleton(redis);
IDataProtectionBuilder dataProtection = builder.Services.AddDataProtection()
    .SetApplicationName("Axis.ReferenceProduct.Bff")
    .PersistKeysToStackExchangeRedis(redis, "axis-reference-product:data-protection");
if (!builder.Environment.IsDevelopment() && !builder.Environment.IsEnvironment("Testing"))
{
    string certificatePath = builder.Configuration["DataProtection:CertificatePath"]
        ?? throw new InvalidOperationException("DataProtection:CertificatePath is required outside Development and Testing.");
    string certificatePassword = builder.Configuration["DataProtection:CertificatePassword"]
        ?? throw new InvalidOperationException("DataProtection:CertificatePassword is required outside Development and Testing.");
    dataProtection.ProtectKeysWithCertificate(X509CertificateLoader.LoadPkcs12FromFile(certificatePath, certificatePassword));
}

builder.Services.AddSingleton<RedisTicketStore>();
builder.Services.AddAntiforgery(options =>
{
    options.Cookie.Name = "__Host-axis-reference-product-antiforgery";
    options.Cookie.HttpOnly = true;
    options.Cookie.Path = "/";
    options.Cookie.SameSite = SameSiteMode.Strict;
    options.Cookie.SecurePolicy = CookieSecurePolicy.Always;
    options.HeaderName = "X-CSRF-TOKEN";
    options.FormFieldName = AntiforgeryFormFieldName;
});

const string CookieScheme = "product-cookie";
const string OidcScheme = "axis-oidc";
builder.Services.AddAuthentication(options =>
    {
        options.DefaultScheme = CookieScheme;
        options.DefaultAuthenticateScheme = CookieScheme;
        options.DefaultChallengeScheme = CookieScheme;
    })
    .AddCookie(CookieScheme, options =>
    {
        options.Cookie.Name = "__Host-axis-reference-product-session";
        options.Cookie.HttpOnly = true;
        options.Cookie.IsEssential = true;
        options.Cookie.Path = "/";
        options.Cookie.SameSite = SameSiteMode.Lax;
        options.Cookie.SecurePolicy = CookieSecurePolicy.Always;
        options.ExpireTimeSpan = settings.IdleLifetime;
        options.SlidingExpiration = true;
        options.Events.OnRedirectToLogin = context =>
        {
            context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            return Task.CompletedTask;
        };
        options.Events.OnValidatePrincipal = context =>
        {
            bool valid = context.Properties.Items.TryGetValue(RedisTicketStore.AbsoluteExpiryProperty, out string? raw) &&
                DateTimeOffset.TryParseExact(raw, "O", CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out DateTimeOffset expiry) &&
                expiry > DateTimeOffset.UtcNow;
            if (!valid) context.RejectPrincipal();
            return Task.CompletedTask;
        };
    })
    .AddOpenIdConnect(OidcScheme, options =>
    {
        options.Authority = settings.Authority.AbsoluteUri.TrimEnd('/');
        options.ClientId = settings.ClientId;
        options.ClientSecret = settings.ClientSecret;
        options.ResponseType = OpenIdConnectResponseType.Code;
        options.ResponseMode = OpenIdConnectResponseMode.Query;
        options.UsePkce = true;
        options.PushedAuthorizationBehavior = PushedAuthorizationBehavior.Require;
        options.MapInboundClaims = false;
        options.SaveTokens = true;
        options.GetClaimsFromUserInfoEndpoint = false;
        options.Scope.Clear();
        options.Scope.Add("openid");
        options.Scope.Add("profile");
        options.Scope.Add("email");
        options.Scope.Add("offline_access");
        options.TokenValidationParameters = new TokenValidationParameters
        {
            NameClaimType = "name",
            RoleClaimType = "role",
            ValidateIssuer = true,
        };
        options.BackchannelHttpHandler = BackchannelTransport.Create(settings);
        options.Events.OnTokenValidated = context =>
        {
            ClaimsIdentity identity = (ClaimsIdentity)context.Principal!.Identity!;
            identity.AddClaim(new Claim("axis_reference_product_session_id", Guid.NewGuid().ToString("N")));
            DateTimeOffset now = DateTimeOffset.UtcNow;
            context.Properties!.IssuedUtc = now;
            context.Properties.ExpiresUtc = now.Add(settings.IdleLifetime);
            context.Properties.AllowRefresh = true;
            context.Properties.IsPersistent = false;
            context.Properties.Items[RedisTicketStore.AbsoluteExpiryProperty] = now.Add(settings.AbsoluteLifetime).ToString("O", CultureInfo.InvariantCulture);
            return Task.CompletedTask;
        };
    });
builder.Services.AddOptions<CookieAuthenticationOptions>(CookieScheme)
    .Configure<RedisTicketStore>((options, store) => options.SessionStore = store);
builder.Services.AddAuthorization();
builder.Services.AddHttpContextAccessor();
builder.Services.AddOpenIdConnectAccessTokenManagement(options =>
    options.RefreshBeforeExpiration = TimeSpan.FromMinutes(2));
builder.Services.AddScoped<IUserTokenRequestConcurrencyControl, RedisTokenConcurrencyControl>();

builder.Services.AddSingleton<AxisApiTransformer>();
builder.Services.AddSingleton(new HttpMessageInvoker(new SocketsHttpHandler
{
    ConnectTimeout = TimeSpan.FromSeconds(10),
    PooledConnectionLifetime = TimeSpan.FromMinutes(10),
    UseProxy = false,
}));
builder.Services.AddHttpForwarder();
builder.WebHost.ConfigureKestrel(options => options.Limits.MaxRequestBodySize = 1_048_576);

WebApplication app = builder.Build();
app.UseForwardedHeaders(new ForwardedHeadersOptions
{
    ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto,
});
app.UseHttpsRedirection();
app.UseStaticFiles();
app.UseRouting();
app.UseAuthentication();
app.UseAuthorization();

app.MapGet("/health", () => Results.Ok(new { status = "healthy" })).AllowAnonymous();
app.MapGet("/bff/session", (HttpContext context, Microsoft.AspNetCore.Antiforgery.IAntiforgery antiforgery) =>
{
    string csrfToken = antiforgery.GetAndStoreTokens(context).RequestToken
        ?? throw new InvalidOperationException("Antiforgery did not issue a request token.");
    if (context.User.Identity?.IsAuthenticated != true)
        return Results.Ok(new { authenticated = false, csrfToken, user = (object?)null });
    return Results.Ok(new
    {
        authenticated = true,
        csrfToken,
        user = new
        {
            userId = context.User.FindFirstValue("sub"),
            email = context.User.FindFirstValue("email"),
            name = context.User.FindFirstValue("name"),
        },
    });
}).AllowAnonymous();
app.MapGet("/bff/login", (string? returnUrl) =>
{
    string destination = LocalReturnUrl.IsValid(returnUrl) ? returnUrl! : "/";
    return Results.Challenge(new AuthenticationProperties { RedirectUri = destination }, [OidcScheme]);
}).AllowAnonymous();
app.MapPost("/bff/logout", async (HttpContext context, Microsoft.AspNetCore.Antiforgery.IAntiforgery antiforgery) =>
{
    await antiforgery.ValidateRequestAsync(context);
    try { await context.RevokeRefreshTokenAsync(ct: context.RequestAborted); }
    catch (Exception exception) { app.Logger.LogWarning(exception, "Refresh token revocation failed during BFF logout."); }
    return Results.SignOut(new AuthenticationProperties { RedirectUri = "/" }, [CookieScheme, OidcScheme]);
}).RequireAuthorization();

app.UseWhen(
    context => context.Request.Path.StartsWithSegments("/api"),
    branch => branch.UseMiddleware<ApiGatewayMiddleware>());
ForwarderRequestConfig forwarderConfig = new()
{
    ActivityTimeout = TimeSpan.FromSeconds(30),
};
app.MapForwarder(
        "/api/{**catch-all}",
        settings.ApiBaseUrl.AbsoluteUri,
        forwarderConfig,
        app.Services.GetRequiredService<AxisApiTransformer>(),
        app.Services.GetRequiredService<HttpMessageInvoker>())
    .RequireAuthorization();
app.MapFallbackToFile("index.html");
app.Run();

public partial class Program;

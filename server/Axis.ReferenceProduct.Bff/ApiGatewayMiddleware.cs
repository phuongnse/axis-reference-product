using System.Net.Http.Headers;
using System.Text.RegularExpressions;
using Duende.AccessTokenManagement;
using Duende.AccessTokenManagement.OpenIdConnect;
using Microsoft.AspNetCore.Antiforgery;
using Yarp.ReverseProxy.Forwarder;

namespace Axis.ReferenceProduct.Bff;

internal sealed partial class ApiGatewayMiddleware(RequestDelegate next)
{
    internal const string AccessTokenItem = "Axis.ReferenceProduct.Bff.AccessToken";
    private static readonly HashSet<string> UnsafeMethods = new(StringComparer.OrdinalIgnoreCase)
        { "POST", "PUT", "PATCH", "DELETE" };

    public async Task InvokeAsync(HttpContext context, IAntiforgery antiforgery)
    {
        if (!IsAllowed(context.Request.Method, context.Request.Path))
        {
            context.Response.StatusCode = StatusCodes.Status404NotFound;
            return;
        }
        if (UnsafeMethods.Contains(context.Request.Method))
            await antiforgery.ValidateRequestAsync(context);

        TokenResult<UserToken> result = await context.GetUserAccessTokenAsync(ct: context.RequestAborted);
        if (!result.Succeeded)
        {
            context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            return;
        }
        context.Items[AccessTokenItem] = result.Token.AccessToken.ToString();
        await next(context);
    }

    internal static bool IsAllowed(string method, PathString path)
    {
        string value = path.Value ?? string.Empty;
        return (method, value) switch
        {
            ("GET", "/api/users/me") => true,
            ("GET" or "POST", "/api/business-object-definitions") => true,
            ("GET", _) when DefinitionDetailPath().IsMatch(value) => true,
            ("PUT", _) when DefinitionSavePath().IsMatch(value) => true,
            ("POST", _) when DefinitionPublishPath().IsMatch(value) => true,
            ("GET", _) when RuleDefinitionPath().IsMatch(value) => true,
            ("GET", _) when RuleUsagePath().IsMatch(value) => true,
            ("GET", _) when BindingDetailPath().IsMatch(value) => true,
            ("POST", "/api/rule-bindings") => true,
            ("POST", _) when RecordCreatePath().IsMatch(value) => true,
            ("PUT", _) when RecordSavePath().IsMatch(value) => true,
            ("POST", _) when RecordSubmitPath().IsMatch(value) => true,
            _ => false,
        };
    }

    private const string GuidPattern = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}";
    [GeneratedRegex("^/api/business-object-definitions/" + GuidPattern + "$", RegexOptions.CultureInvariant)] private static partial Regex DefinitionDetailPath();
    [GeneratedRegex("^/api/business-object-definitions/" + GuidPattern + "/unpublished$", RegexOptions.CultureInvariant)] private static partial Regex DefinitionSavePath();
    [GeneratedRegex("^/api/business-object-definitions/" + GuidPattern + "/publish$", RegexOptions.CultureInvariant)] private static partial Regex DefinitionPublishPath();
    [GeneratedRegex("^/api/rules/[a-z][a-z0-9._-]{0,99}$", RegexOptions.CultureInvariant)] private static partial Regex RuleDefinitionPath();
    [GeneratedRegex("^/api/rules/[a-z][a-z0-9._-]{0,99}/bindings$", RegexOptions.CultureInvariant)] private static partial Regex RuleUsagePath();
    [GeneratedRegex("^/api/rule-bindings/" + GuidPattern + "$", RegexOptions.CultureInvariant)] private static partial Regex BindingDetailPath();
    [GeneratedRegex("^/api/business-object-records/[a-z][a-z0-9_]{0,99}$", RegexOptions.CultureInvariant)] private static partial Regex RecordCreatePath();
    [GeneratedRegex("^/api/business-object-records/" + GuidPattern + "$", RegexOptions.CultureInvariant)] private static partial Regex RecordSavePath();
    [GeneratedRegex("^/api/business-object-records/" + GuidPattern + "/submit$", RegexOptions.CultureInvariant)] private static partial Regex RecordSubmitPath();
}

internal sealed class AxisApiTransformer : HttpTransformer
{
    private static readonly HashSet<string> AllowedHeaders = new(StringComparer.OrdinalIgnoreCase)
        { "Accept", "Accept-Language", "Content-Type", "Idempotency-Key", "If-Match", "If-None-Match", "X-Correlation-ID" };

    public override async ValueTask TransformRequestAsync(
        HttpContext httpContext,
        HttpRequestMessage proxyRequest,
        string destinationPrefix,
        CancellationToken cancellationToken)
    {
        await base.TransformRequestAsync(httpContext, proxyRequest, destinationPrefix, cancellationToken);
        foreach (string header in proxyRequest.Headers.Select(header => header.Key).Where(header => !AllowedHeaders.Contains(header)).ToArray())
            proxyRequest.Headers.Remove(header);
        if (proxyRequest.Content is not null)
        {
            foreach (string header in proxyRequest.Content.Headers.Select(header => header.Key).Where(header => !AllowedHeaders.Contains(header)).ToArray())
                proxyRequest.Content.Headers.Remove(header);
        }
        string token = (string)httpContext.Items[ApiGatewayMiddleware.AccessTokenItem]!;
        proxyRequest.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        proxyRequest.Headers.Host = null;
    }
}

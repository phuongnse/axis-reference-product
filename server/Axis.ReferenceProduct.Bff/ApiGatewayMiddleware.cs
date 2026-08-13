using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.RegularExpressions;
using Duende.AccessTokenManagement;
using Duende.AccessTokenManagement.OpenIdConnect;
using Microsoft.AspNetCore.Antiforgery;
using Yarp.ReverseProxy.Forwarder;

namespace Axis.ReferenceProduct.Bff;

internal sealed partial class ApiGatewayMiddleware(RequestDelegate next)
{
    internal const string AccessTokenItem = "Axis.ReferenceProduct.Bff.AccessToken";
    internal const string ProductObjectKey = "loan_application";
    private static readonly HashSet<string> UnsafeMethods = new(StringComparer.OrdinalIgnoreCase)
        { "POST", "PUT", "PATCH", "DELETE" };

    public async Task InvokeAsync(
        HttpContext context,
        IAntiforgery antiforgery,
        BffOptions options,
        HttpMessageInvoker http)
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
        string accessToken = result.Token.AccessToken.ToString();
        if (TryGetRecordId(context.Request.Path, out Guid recordId) &&
            !await IsProductRecordAsync(recordId, accessToken, options, http, context.RequestAborted))
        {
            context.Response.StatusCode = StatusCodes.Status404NotFound;
            return;
        }
        context.Items[AccessTokenItem] = accessToken;
        await next(context);
    }

    internal static bool IsAllowed(string method, PathString path)
    {
        string value = path.Value ?? string.Empty;
        return (method, value) switch
        {
            ("POST", _) when string.Equals(
                value,
                $"/api/business-object-records/{ProductObjectKey}",
                StringComparison.Ordinal) => true,
            ("GET", _) when RecordPath().IsMatch(value) => true,
            ("PUT", _) when RecordPath().IsMatch(value) => true,
            ("POST", _) when RecordSubmitPath().IsMatch(value) => true,
            _ => false,
        };
    }

    internal static async Task<bool> IsProductRecordAsync(
        Guid recordId,
        string accessToken,
        BffOptions options,
        HttpMessageInvoker http,
        CancellationToken cancellationToken)
    {
        using HttpRequestMessage request = new(
            HttpMethod.Get,
            new Uri(
                $"{options.ApiBaseUrl.AbsoluteUri.TrimEnd('/')}/api/business-object-records/{recordId:D}",
                UriKind.Absolute));
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        using HttpResponseMessage response = await http.SendAsync(request, cancellationToken);
        if (!response.IsSuccessStatusCode)
            return false;

        try
        {
            await using Stream content = await response.Content.ReadAsStreamAsync(cancellationToken);
            using JsonDocument document = await JsonDocument.ParseAsync(content, cancellationToken: cancellationToken);
            return document.RootElement.ValueKind == JsonValueKind.Object &&
                document.RootElement.TryGetProperty("objectKey", out JsonElement objectKey) &&
                objectKey.ValueKind == JsonValueKind.String &&
                string.Equals(objectKey.GetString(), ProductObjectKey, StringComparison.Ordinal);
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static bool TryGetRecordId(PathString path, out Guid recordId)
    {
        recordId = default;
        Match match = ProductRecordPath().Match(path.Value ?? string.Empty);
        return match.Success && Guid.TryParseExact(match.Groups["recordId"].Value, "D", out recordId);
    }

    private const string GuidPattern = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}";
    [GeneratedRegex("^/api/business-object-records/" + GuidPattern + "$", RegexOptions.CultureInvariant)] private static partial Regex RecordPath();
    [GeneratedRegex("^/api/business-object-records/" + GuidPattern + "/submit$", RegexOptions.CultureInvariant)] private static partial Regex RecordSubmitPath();
    [GeneratedRegex("^/api/business-object-records/(?<recordId>" + GuidPattern + ")(?:/submit)?$", RegexOptions.CultureInvariant)] private static partial Regex ProductRecordPath();
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

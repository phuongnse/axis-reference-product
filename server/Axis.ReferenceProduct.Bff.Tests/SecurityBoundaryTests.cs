using System.Net;
using System.Text;
using Axis.ReferenceProduct.Bff;
using Microsoft.AspNetCore.Http;
using Xunit;

namespace Axis.ReferenceProduct.Bff.Tests;

public sealed class SecurityBoundaryTests
{
    [Theory]
    [InlineData("POST", "/api/business-object-records/loan_application")]
    [InlineData("GET", "/api/business-object-records/11111111-1111-4111-8111-111111111111")]
    [InlineData("PUT", "/api/business-object-records/11111111-1111-4111-8111-111111111111")]
    [InlineData("POST", "/api/business-object-records/11111111-1111-4111-8111-111111111111/submit")]
    public void ApiAllowlist_AcceptsOnlyOwnedOperations(string method, string path)
    {
        Assert.True(ApiGatewayMiddleware.IsAllowed(method, new PathString(path)));
    }

    [Theory]
    [InlineData("GET", "/api/auth/session")]
    [InlineData("GET", "/api/users")]
    [InlineData("GET", "/api/business-object-records")]
    [InlineData("POST", "/api/business-object-records/foreign_object")]
    [InlineData("POST", "/api/business-object-records/reference_application")]
    [InlineData("DELETE", "/api/business-object-records/11111111-1111-4111-8111-111111111111")]
    public void ApiAllowlist_RejectsUnownedOperations(string method, string path)
    {
        Assert.False(ApiGatewayMiddleware.IsAllowed(method, new PathString(path)));
    }

    [Fact]
    public async Task RecordBoundary_AcceptsOnlyTheInstalledProductObject()
    {
        StubHandler handler = new(HttpStatusCode.OK, "{\"objectKey\":\"loan_application\"}");

        bool allowed = await ApiGatewayMiddleware.IsProductRecordAsync(
            Guid.Parse("11111111-1111-4111-8111-111111111111"),
            "access-token",
            Options(),
            new HttpMessageInvoker(handler),
            TestContext.Current.CancellationToken);

        Assert.True(allowed);
        Assert.Equal(
            new Uri("https://axis.example/api/business-object-records/11111111-1111-4111-8111-111111111111"),
            handler.RequestUri);
        Assert.Equal("Bearer", handler.AuthorizationScheme);
        Assert.Equal("access-token", handler.AuthorizationParameter);
    }

    [Theory]
    [InlineData(HttpStatusCode.OK, "{\"objectKey\":\"foreign_object\"}")]
    [InlineData(HttpStatusCode.OK, "{\"objectKey\":null}")]
    [InlineData(HttpStatusCode.OK, "not-json")]
    [InlineData(HttpStatusCode.NotFound, "{\"objectKey\":\"loan_application\"}")]
    public async Task RecordBoundary_RejectsForeignUnknownOrInvalidReadBack(
        HttpStatusCode statusCode,
        string content)
    {
        StubHandler handler = new(statusCode, content);

        bool allowed = await ApiGatewayMiddleware.IsProductRecordAsync(
            Guid.Parse("11111111-1111-4111-8111-111111111111"),
            "access-token",
            Options(),
            new HttpMessageInvoker(handler),
            TestContext.Current.CancellationToken);

        Assert.False(allowed);
    }

    [Theory]
    [InlineData("/")]
    [InlineData("/#applications")]
    [InlineData("/applications?filter=open#current")]
    public void LocalReturnUrl_AcceptsProductLocalDestinations(string value)
    {
        Assert.True(LocalReturnUrl.IsValid(value));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("https://attacker.example/")]
    [InlineData("//attacker.example/")]
    [InlineData("/safe\r\nLocation: https://attacker.example")]
    public void LocalReturnUrl_RejectsExternalOrMalformedDestinations(string? value)
    {
        Assert.False(LocalReturnUrl.IsValid(value));
    }

    private static BffOptions Options() => new(
        new Uri("https://identity.example"),
        new Uri("https://axis.example"),
        "client",
        new string('s', 32),
        "redis",
        TimeSpan.FromMinutes(30),
        TimeSpan.FromHours(8),
        null,
        null);

    private sealed class StubHandler(HttpStatusCode statusCode, string content) : HttpMessageHandler
    {
        public Uri? RequestUri { get; private set; }
        public string? AuthorizationScheme { get; private set; }
        public string? AuthorizationParameter { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            RequestUri = request.RequestUri;
            AuthorizationScheme = request.Headers.Authorization?.Scheme;
            AuthorizationParameter = request.Headers.Authorization?.Parameter;
            return Task.FromResult(new HttpResponseMessage(statusCode)
            {
                Content = new StringContent(content, Encoding.UTF8, "application/json"),
            });
        }
    }
}

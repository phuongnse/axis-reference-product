using Axis.ReferenceProduct.Bff;
using Microsoft.AspNetCore.Http;
using Xunit;

namespace Axis.ReferenceProduct.Bff.Tests;

public sealed class SecurityBoundaryTests
{
    [Theory]
    [InlineData("GET", "/api/users/me")]
    [InlineData("POST", "/api/business-object-definitions")]
    [InlineData("PUT", "/api/business-object-definitions/11111111-1111-4111-8111-111111111111/unpublished")]
    [InlineData("POST", "/api/business-object-definitions/11111111-1111-4111-8111-111111111111/publish")]
    [InlineData("GET", "/api/rules/field.required")]
    [InlineData("GET", "/api/rules/field.required/bindings")]
    [InlineData("POST", "/api/rule-bindings")]
    [InlineData("GET", "/api/rule-bindings/11111111-1111-4111-8111-111111111111")]
    [InlineData("POST", "/api/business-object-records/reference_application")]
    [InlineData("PUT", "/api/business-object-records/11111111-1111-4111-8111-111111111111")]
    [InlineData("POST", "/api/business-object-records/11111111-1111-4111-8111-111111111111/submit")]
    public void ApiAllowlist_AcceptsOnlyOwnedOperations(string method, string path)
    {
        Assert.True(ApiGatewayMiddleware.IsAllowed(method, new PathString(path)));
    }

    [Theory]
    [InlineData("DELETE", "/api/business-object-definitions/11111111-1111-4111-8111-111111111111")]
    [InlineData("GET", "/api/auth/session")]
    [InlineData("GET", "/api/users")]
    [InlineData("GET", "/api/rules/../users/me")]
    [InlineData("GET", "/api/rule-bindings/not-a-guid")]
    public void ApiAllowlist_RejectsUnownedOperations(string method, string path)
    {
        Assert.False(ApiGatewayMiddleware.IsAllowed(method, new PathString(path)));
    }

    [Theory]
    [InlineData("/")]
    [InlineData("/#provision")]
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
}

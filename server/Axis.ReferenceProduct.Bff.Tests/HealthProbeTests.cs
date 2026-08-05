using System.Net;
using Probe = Axis.ReferenceProduct.HealthProbe.HealthProbe;
using Xunit;

namespace Axis.ReferenceProduct.Bff.Tests;

public sealed class HealthProbeTests
{
    [Fact]
    public async Task CheckAsync_RequestsTheExactHealthEndpoint_AndSucceedsFor2xx()
    {
        RecordingHandler handler = new(() => new HttpResponseMessage(HttpStatusCode.NoContent));

        int exitCode = await Probe.CheckAsync(handler, TestContext.Current.CancellationToken);

        Assert.Equal(0, exitCode);
        Assert.Equal(1, handler.RequestCount);
        Assert.NotNull(handler.Request);
        Assert.Equal(HttpMethod.Get, handler.Request.Method);
        Assert.Equal(Probe.Endpoint, handler.Request.RequestUri);
    }

    [Theory]
    [InlineData(HttpStatusCode.BadRequest)]
    [InlineData(HttpStatusCode.InternalServerError)]
    public async Task CheckAsync_ReturnsNonZeroForNon2xxResponses(HttpStatusCode statusCode)
    {
        RecordingHandler handler = new(() => new HttpResponseMessage(statusCode));

        int exitCode = await Probe.CheckAsync(handler, TestContext.Current.CancellationToken);

        Assert.Equal(1, exitCode);
        Assert.Equal(1, handler.RequestCount);
    }

    [Fact]
    public async Task CheckAsync_ReturnsNonZeroWithoutRetryingRequestFailures()
    {
        RecordingHandler handler = new(() => throw new HttpRequestException());

        int exitCode = await Probe.CheckAsync(handler, TestContext.Current.CancellationToken);

        Assert.Equal(1, exitCode);
        Assert.Equal(1, handler.RequestCount);
    }

    [Fact]
    public void RequestTimeout_IsFiniteAndShorterThanComposeTimeout()
    {
        Assert.True(Probe.RequestTimeout > TimeSpan.Zero);
        Assert.True(Probe.RequestTimeout < TimeSpan.FromSeconds(5));
    }

    private sealed class RecordingHandler(Func<HttpResponseMessage> responseFactory) : HttpMessageHandler
    {
        public HttpRequestMessage? Request { get; private set; }

        public int RequestCount { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Request = request;
            RequestCount++;
            return Task.FromResult(responseFactory());
        }
    }
}

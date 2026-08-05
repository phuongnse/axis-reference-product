namespace Axis.ReferenceProduct.HealthProbe;

public static class HealthProbe
{
    public static readonly Uri Endpoint = new("https://localhost:4173/health", UriKind.Absolute);
    public static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(4);

    public static async Task<int> CheckAsync(HttpMessageHandler handler, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(handler);

        using HttpClient client = new(handler, disposeHandler: false)
        {
            Timeout = RequestTimeout,
        };

        try
        {
            using HttpResponseMessage response = await client.GetAsync(
                Endpoint,
                HttpCompletionOption.ResponseHeadersRead,
                cancellationToken);
            return response.IsSuccessStatusCode ? 0 : 1;
        }
        catch (HttpRequestException)
        {
            return 1;
        }
        catch (OperationCanceledException)
        {
            return 1;
        }
    }
}

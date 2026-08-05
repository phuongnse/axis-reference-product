using System.Net.Sockets;

namespace Axis.ReferenceProduct.Bff;

internal static class BackchannelTransport
{
    public static SocketsHttpHandler Create(BffOptions options)
    {
        SocketsHttpHandler handler = new()
        {
            ConnectTimeout = TimeSpan.FromSeconds(10),
            PooledConnectionLifetime = TimeSpan.FromMinutes(10),
        };
        if (options.BackchannelHost is null || options.BackchannelPort is null)
            return handler;

        string authorityHost = options.Authority.Host;
        int authorityPort = options.Authority.IsDefaultPort ? 443 : options.Authority.Port;
        handler.ConnectCallback = async (context, cancellationToken) =>
        {
            string host = context.DnsEndPoint.Host;
            int port = context.DnsEndPoint.Port;
            if (string.Equals(host, authorityHost, StringComparison.OrdinalIgnoreCase) && port == authorityPort)
            {
                host = options.BackchannelHost;
                port = options.BackchannelPort.Value;
            }

            TcpClient client = new();
            try
            {
                await client.ConnectAsync(host, port, cancellationToken);
                return client.GetStream();
            }
            catch
            {
                client.Dispose();
                throw;
            }
        };
        return handler;
    }
}

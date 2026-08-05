namespace Axis.ReferenceProduct.Bff;

internal static class LocalReturnUrl
{
    public static bool IsValid(string? value) =>
        !string.IsNullOrWhiteSpace(value) &&
        value.StartsWith("/", StringComparison.Ordinal) &&
        !value.StartsWith("//", StringComparison.Ordinal) &&
        !value.Any(char.IsControl);
}

using System;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace RehaFlow.CommandCenter;

public sealed class NativeApi
{
    private const string SiteBase = "https://gregarious-frangollo-24145c.netlify.app";
    private static readonly string[] ApiBases =
    {
        SiteBase + "/api/baas",
        SiteBase + "/.netlify/functions/baas",
        SiteBase + "/.netlify/functions/api",
        SiteBase + "/api"
    };

    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(30) };

    public async Task<JsonNode?> SendAsync(string method, string path, string? body, string? token, CancellationToken cancellationToken = default)
    {
        if (!path.StartsWith('/')) path = "/" + path;

        Exception? lastError = null;
        foreach (var baseUrl in ApiBases)
        {
            try
            {
                return await SendOnceAsync(method, baseUrl.TrimEnd('/') + path, body, token, cancellationToken);
            }
            catch (ApiRouteNotFoundException ex)
            {
                lastError = ex;
            }
        }

        throw lastError ?? new InvalidOperationException("API endpoint не знайдено.");
    }

    private async Task<JsonNode?> SendOnceAsync(string method, string url, string? body, string? token, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(new HttpMethod(method), url);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        request.Headers.TryAddWithoutValidation("X-Client", "rehaflow-windows-native");
        request.Headers.TryAddWithoutValidation("X-Device-Id", "windows-desktop");
        request.Headers.TryAddWithoutValidation("X-Device-Name", "RehaFlow Command Center");
        request.Headers.TryAddWithoutValidation("X-Device-Platform", "windows");
        request.Headers.TryAddWithoutValidation("X-App-Version", "0.1.0");
        if (!string.IsNullOrWhiteSpace(token))
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        if (!string.IsNullOrWhiteSpace(body))
            request.Content = new StringContent(body, Encoding.UTF8, "application/json");

        using var response = await _http.SendAsync(request, cancellationToken);
        var raw = await response.Content.ReadAsStringAsync(cancellationToken);
        JsonNode? data = null;
        try { data = string.IsNullOrWhiteSpace(raw) ? null : JsonNode.Parse(raw); }
        catch (JsonException) { }

        if (response.StatusCode == System.Net.HttpStatusCode.NotFound || IsNotFoundPayload(data, raw))
            throw new ApiRouteNotFoundException();

        if (response.StatusCode == System.Net.HttpStatusCode.Unauthorized)
            throw new InvalidOperationException("RF_AUTH_EXPIRED");

        if (!response.IsSuccessStatusCode)
            throw new InvalidOperationException(ExtractMessage(data, raw, (int)response.StatusCode));

        if (data is null && !string.IsNullOrWhiteSpace(raw))
            throw new InvalidOperationException($"API повернув не-JSON відповідь (HTTP {(int)response.StatusCode}).");

        return data;
    }

    private static bool IsNotFoundPayload(JsonNode? data, string raw)
    {
        if (data is JsonObject obj && obj["error"] is JsonValue e)
        {
            var message = e.ToString();
            if (message.Contains("endpoint not found", StringComparison.OrdinalIgnoreCase))
                return true;
        }
        return raw.Contains("<title>Page not found</title>", StringComparison.OrdinalIgnoreCase)
            || raw.Contains("<!DOCTYPE html", StringComparison.OrdinalIgnoreCase);
    }

    private sealed class ApiRouteNotFoundException : Exception { }

    private static string ExtractMessage(JsonNode? data, string raw, int status)
    {
        if (data is JsonObject obj)
        {
            if (obj["error"] is JsonObject error && error["message"] is JsonValue message)
                return message.ToString();
            if (obj["error"] is JsonValue value) return value.ToString();
            if (obj["message"] is JsonValue msg) return msg.ToString();
        }

        var text = (raw ?? string.Empty).Trim();
        if (text.Contains("<title>Page not found</title>", StringComparison.OrdinalIgnoreCase) || text.Contains("<!DOCTYPE html", StringComparison.OrdinalIgnoreCase))
            return $"API endpoint не знайдено (HTTP {status}).";
        if (text.Length > 800) text = text[..800];
        return string.IsNullOrWhiteSpace(text) ? $"HTTP {status}" : text;
    }
}

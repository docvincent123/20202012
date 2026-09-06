using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Windows;
using Microsoft.Web.WebView2.Wpf;
using Microsoft.Web.WebView2.Core;

namespace RehaFlow.CommandCenter;

public partial class MainWindow : Window
{
    private const string FrontendPrefix = "rehaflow/";
    private readonly WebView2 _browser;
    private readonly NativeApi _api = new();

    public MainWindow()
    {
        InitializeComponent();
        _browser = new WebView2 { HorizontalAlignment = HorizontalAlignment.Stretch, VerticalAlignment = VerticalAlignment.Stretch };
        Host.Children.Add(_browser);
        Loaded += async (_, _) => await StartAsync();
    }

    private async System.Threading.Tasks.Task StartAsync()
    {
        try
        {
            await _browser.EnsureCoreWebView2Async();
            _browser.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
            _browser.CoreWebView2.Settings.AreDevToolsEnabled = true;
            _browser.CoreWebView2.WebMessageReceived += OnWebMessageReceived;

            await _browser.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync("""
(() => {
  const pending = new Map();
  window.__rfNativeResolve = (id, ok, data) => {
    const item = pending.get(id);
    if (!item) return;
    pending.delete(id);
    ok ? item.resolve(data) : item.reject(new Error(String(data || 'Native API error')));
  };
  window.__rfNativeApi = request => new Promise((resolve, reject) => {
    const id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
    pending.set(id, { resolve, reject });
    chrome.webview.postMessage(JSON.stringify({ ...request, id, type: 'api' }));
  });
  const showFatal = msg => {
    try {
      const render = () => {
        let box = document.getElementById('rf-fatal');
        if (!box) { box = document.createElement('div'); box.id = 'rf-fatal'; document.body.appendChild(box); }
        box.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#061412;color:#e8fffa;font:14px/1.45 Segoe UI,Arial,sans-serif;padding:32px;box-sizing:border-box;overflow:auto';
        box.innerHTML = '<h2 style="margin:0 0 12px">RehaFlow не зміг завантажити інтерфейс</h2><pre style="white-space:pre-wrap;opacity:.85">' + String(msg || 'Невідома помилка').replace(/[&<>]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;' }[c])) + '</pre><p style="opacity:.7">Відкрийте DevTools для технічної інформації.</p>';
      };
      if (document.body) render(); else window.addEventListener('DOMContentLoaded', render, { once: true });
    } catch {}
  };
  window.addEventListener('error', e => showFatal(e?.error?.stack || e?.message || 'JavaScript error'));
  window.addEventListener('unhandledrejection', e => showFatal(e?.reason?.stack || e?.reason || 'Unhandled promise rejection'));
})();
""");

            var root = ResolveFrontendRoot();
            _browser.CoreWebView2.SetVirtualHostNameToFolderMapping("rehaflow.local", root, CoreWebView2HostResourceAccessKind.Allow);
            _browser.CoreWebView2.Navigate("https://rehaflow.local/index.html");
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, "RehaFlow", MessageBoxButton.OK, MessageBoxImage.Error);
            Close();
        }
    }

    private async void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        string id = string.Empty;
        try
        {
            var message = e.TryGetWebMessageAsString();
            if (string.IsNullOrWhiteSpace(message)) return;

            using var doc = JsonDocument.Parse(message);
            var root = doc.RootElement;
            if (!root.TryGetProperty("type", out var type) || type.GetString() != "api") return;
            id = root.GetProperty("id").GetString() ?? string.Empty;
            var method = root.TryGetProperty("method", out var m) ? m.GetString() ?? "GET" : "GET";
            var path = root.TryGetProperty("path", out var p) ? p.GetString() ?? "/" : "/";
            var body = root.TryGetProperty("body", out var b) && b.ValueKind != JsonValueKind.Null ? b.GetString() : null;
            var token = root.TryGetProperty("token", out var t) ? t.GetString() : null;
            var data = await _api.SendAsync(method, path, body, token);
            await ResolveNativeAsync(id, true, data);
        }
        catch (Exception ex)
        {
            if (string.Equals(ex.Message, "RF_AUTH_EXPIRED", StringComparison.Ordinal))
            {
                try { await _browser.CoreWebView2.ExecuteScriptAsync("window.dispatchEvent(new CustomEvent('rf-auth-expired')); "); } catch { }
            }
            if (!string.IsNullOrWhiteSpace(id)) await ResolveNativeAsync(id, false, JsonValue.Create(ex.Message));
        }
    }

    private async System.Threading.Tasks.Task ResolveNativeAsync(string id, bool ok, JsonNode? data)
    {
        var idJson = JsonSerializer.Serialize(id);
        var dataJson = ok ? (data?.ToJsonString() ?? "null") : JsonSerializer.Serialize(data?.ToString() ?? "Native API error");
        await _browser.CoreWebView2.ExecuteScriptAsync($"window.__rfNativeResolve({idJson},{(ok ? "true" : "false")},{dataJson});");
    }

    private static string ResolveFrontendRoot()
    {
        var bundledRoot = Path.Combine(AppContext.BaseDirectory, "wwwroot");
        if (File.Exists(Path.Combine(bundledRoot, "index.html"))) return bundledRoot;
        var assembly = Assembly.GetExecutingAssembly();
        var resources = assembly.GetManifestResourceNames().Where(n => n.StartsWith(FrontendPrefix, StringComparison.Ordinal)).ToArray();
        if (resources.Length == 0) throw new InvalidOperationException("Вбудований React frontend не знайдено у RehaFlow.CommandCenter.exe.");
        var version = assembly.GetName().Version?.ToString() ?? "0.1.0";
        var root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "QureMed", "RehaFlow", "Web", version);
        Directory.CreateDirectory(root);
        foreach (var resourceName in resources)
        {
            var relative = resourceName[FrontendPrefix.Length..].Replace('/', Path.DirectorySeparatorChar);
            var target = Path.GetFullPath(Path.Combine(root, relative));
            var rootFull = Path.GetFullPath(root + Path.DirectorySeparatorChar);
            if (!target.StartsWith(rootFull, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Некоректний шлях React resource.");
            var directory = Path.GetDirectoryName(target);
            if (!string.IsNullOrWhiteSpace(directory)) Directory.CreateDirectory(directory);
            using var input = assembly.GetManifestResourceStream(resourceName) ?? throw new InvalidOperationException("Не вдалося прочитати React resource: " + relative);
            using var output = File.Create(target);
            input.CopyTo(output);
        }
        var index = Path.Combine(root, "index.html");
        if (!File.Exists(index)) throw new InvalidOperationException("Вбудований React frontend не містить index.html.");
        return root;
    }
}

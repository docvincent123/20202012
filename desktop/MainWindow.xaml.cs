using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Windows;
using Microsoft.Web.WebView2.Wpf;
using Microsoft.Web.WebView2.Core;

namespace RehaFlow.CommandCenter;

public partial class MainWindow : Window
{
    private const string FrontendPrefix = "rehaflow/";
    private readonly WebView2 _browser;

    public MainWindow()
    {
        InitializeComponent();
        _browser = new WebView2
        {
            HorizontalAlignment = System.Windows.HorizontalAlignment.Stretch,
            VerticalAlignment = System.Windows.VerticalAlignment.Stretch
        };
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

            var root = ResolveFrontendRoot();
            _browser.CoreWebView2.SetVirtualHostNameToFolderMapping(
                "rehaflow.local",
                root,
                CoreWebView2HostResourceAccessKind.Allow);
            _browser.CoreWebView2.Navigate("https://rehaflow.local/index.html");
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, "RehaFlow", MessageBoxButton.OK, MessageBoxImage.Error);
            Close();
        }
    }

    private static string ResolveFrontendRoot()
    {
        var bundledRoot = Path.Combine(AppContext.BaseDirectory, "wwwroot");
        if (File.Exists(Path.Combine(bundledRoot, "index.html")))
            return bundledRoot;

        var assembly = Assembly.GetExecutingAssembly();
        var resources = assembly.GetManifestResourceNames()
            .Where(name => name.StartsWith(FrontendPrefix, StringComparison.Ordinal))
            .ToArray();

        if (resources.Length == 0)
            throw new InvalidOperationException("Вбудований React frontend не знайдено у RehaFlow.CommandCenter.exe.");

        var version = assembly.GetName().Version?.ToString() ?? "0.1.0";
        var root = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "QureMed",
            "RehaFlow",
            "Web",
            version);
        Directory.CreateDirectory(root);

        foreach (var resourceName in resources)
        {
            var relative = resourceName[FrontendPrefix.Length..]
                .Replace('/', Path.DirectorySeparatorChar);
            var target = Path.GetFullPath(Path.Combine(root, relative));
            var rootFull = Path.GetFullPath(root + Path.DirectorySeparatorChar);
            if (!target.StartsWith(rootFull, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Некоректний шлях React resource.");

            var directory = Path.GetDirectoryName(target);
            if (!string.IsNullOrWhiteSpace(directory))
                Directory.CreateDirectory(directory);

            using var input = assembly.GetManifestResourceStream(resourceName)
                ?? throw new InvalidOperationException("Не вдалося прочитати React resource: " + relative);
            using var output = File.Create(target);
            input.CopyTo(output);
        }

        var index = Path.Combine(root, "index.html");
        if (!File.Exists(index))
            throw new InvalidOperationException("Вбудований React frontend не містить index.html.");

        return root;
    }
}

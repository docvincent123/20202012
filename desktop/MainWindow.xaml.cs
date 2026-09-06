using System;
using System.IO;
using System.Windows;
using Microsoft.Web.WebView2.Wpf;
using Microsoft.Web.WebView2.Core;

namespace RehaFlow.CommandCenter;

public partial class MainWindow : Window
{
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

            var root = Path.Combine(AppContext.BaseDirectory, "wwwroot");
            var index = Path.Combine(root, "index.html");
            if (!File.Exists(index))
                throw new InvalidOperationException("Frontend не знайдено: " + index);

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
}

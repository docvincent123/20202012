using System;
using System.IO;
using System.Windows;
using Microsoft.Web.WebView2.Core;
namespace RehaFlow.CommandCenter;
public partial class MainWindow : Window
{
  public MainWindow(){InitializeComponent();Loaded+=async(_,_)=>await StartAsync();}
  private async System.Threading.Tasks.Task StartAsync(){
    try{
      await Browser.EnsureCoreWebView2Async();
      Browser.CoreWebView2.Settings.AreDefaultContextMenusEnabled=false;
      Browser.CoreWebView2.Settings.AreDevToolsEnabled=true;
      var root=Path.Combine(AppContext.BaseDirectory,"wwwroot");
      var index=Path.Combine(root,"index.html");
      if(!File.Exists(index)) throw new InvalidOperationException("Frontend не знайдено: "+index);
      Browser.CoreWebView2.SetVirtualHostNameToFolderMapping("rehaflow.local",root,CoreWebView2HostResourceAccessKind.Allow);
      Browser.CoreWebView2.Navigate("https://rehaflow.local/index.html");
    }catch(Exception ex){MessageBox.Show(ex.Message,"RehaFlow",MessageBoxButton.OK,MessageBoxImage.Error);Close();}
  }
}

using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

[assembly: AssemblyTitle("Word Explainer PDF Launcher")]
[assembly: AssemblyDescription("Open PDF files in the Word Explainer Chrome extension")]
[assembly: AssemblyCompany("Word Explainer")]
[assembly: AssemblyProduct("Word Explainer")]
[assembly: AssemblyVersion("2.5.1.0")]
[assembly: AssemblyFileVersion("2.5.1.0")]

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            if (args == null || args.Length == 0 || string.IsNullOrWhiteSpace(args[0]))
            {
                throw new ArgumentException("No PDF file was supplied.");
            }

            string installDirectory = AppDomain.CurrentDomain.BaseDirectory;
            string scriptPath = Path.Combine(installDirectory, "WordExplainerLauncher.ps1");
            if (!File.Exists(scriptPath))
            {
                throw new FileNotFoundException("Word Explainer launcher script is missing.", scriptPath);
            }

            string powershellPath = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.System),
                @"WindowsPowerShell\v1.0\powershell.exe"
            );
            if (!File.Exists(powershellPath)) powershellPath = "powershell.exe";

            ProcessStartInfo startInfo = new ProcessStartInfo();
            startInfo.FileName = powershellPath;
            startInfo.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "
                + Quote(scriptPath) + " " + Quote(args[0]);
            startInfo.UseShellExecute = false;
            startInfo.CreateNoWindow = true;
            Process.Start(startInfo);
            return 0;
        }
        catch (Exception error)
        {
            MessageBox.Show(
                error.Message,
                "Word Explainer PDF Launcher",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error
            );
            return 1;
        }
    }

    private static string Quote(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }
}

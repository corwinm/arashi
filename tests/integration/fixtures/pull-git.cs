using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Threading.Tasks;

public static class PullGitShim {
  private static void Log(string value) {
    using (var mutex = new Mutex(false, Environment.GetEnvironmentVariable("PULL_MUTEX"))) {
      mutex.WaitOne();
      try { File.AppendAllText(Environment.GetEnvironmentVariable("PULL_LOG"), value + "\n"); }
      finally { mutex.ReleaseMutex(); }
    }
  }

  private static string AwaitBarrier(string name) {
    var directory = Environment.GetEnvironmentVariable("PULL_BARRIERS");
    var path = Path.Combine(directory, name);
    using (var signalChanged = new AutoResetEvent(false))
    using (var watcher = new FileSystemWatcher(directory, name)) {
      watcher.NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite;
      watcher.Created += (sender, evt) => signalChanged.Set();
      watcher.Changed += (sender, evt) => signalChanged.Set();
      watcher.EnableRaisingEvents = true;
      while (true) {
        if (File.Exists(path)) {
          try {
            var signal = File.ReadAllText(path).Trim();
            if (signal.Length > 0) return signal;
          } catch (IOException) { /* Writer has not finished creating the signal. */ }
        }
        signalChanged.WaitOne();
      }
    }
  }

  public static int Main(string[] args) {
    var name = Path.GetFileName(Directory.GetCurrentDirectory());
    bool pull = args.Length > 0 && args[0] == "pull";
    if (pull) {
      Log("start " + name);
      if (AwaitBarrier(name) == "fail") {
        Log("end " + name);
        return 1;
      }
    }
    if (args.Length > 0 && args[0] == "reset" && name == "repo-02") Log("rollback repo-02");
    var start = new ProcessStartInfo(Environment.GetEnvironmentVariable("PULL_REAL_GIT")) {
      UseShellExecute = false,
      RedirectStandardInput = true,
      RedirectStandardOutput = true,
      RedirectStandardError = true
    };
    start.Arguments = string.Join(" ", args);
    using (var git = Process.Start(start)) {
      git.StandardInput.Close();
      var stdout = git.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
      var stderr = git.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
      git.WaitForExit();
      Task.WaitAll(stdout, stderr);
      if (pull) Log("end " + name);
      return git.ExitCode;
    }
  }
}

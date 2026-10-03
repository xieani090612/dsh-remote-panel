using System.IO;
using System.Text;

namespace DshWsxPanel;

/// <summary>
/// 追加式日志，首选 %LOCALAPPDATA%\DshWsxPanel\panel.log。
///
/// 存在的理由很实际：这是个 WinExe（没有控制台），窗口在
/// <c>InitializeComponent()</c> 里因为一条解析不了的 ThemeResource 而炸掉时，
/// 用户（和我）看到的现象只是「双击了，什么都没发生」。
/// 有一份日志才能分辨「XAML 加载失败」「拿不到 AppWindow」「单实例判定」这些情况。
///
/// 三条硬性约束：
///   * 所有写入都吞掉异常 —— 日志失败绝不能连累窗口；
///   * 首选目录写不进去时**逐级回退**（exe 旁边、%TEMP%），而不是干脆没有日志；
///   * 每次探测的结果都留在 <see cref="Diagnostic"/> 里，并能在 --dump-status 中打出来 ——
///     否则「没有日志」这件事本身就成了新的黑盒（这里踩过一次：面板在某个环境下
///     对 %LOCALAPPDATA% 的写入被拒绝，现象就是「日志凭空不存在」）。
/// </summary>
public static class Log
{
    private static readonly object Gate = new();
    private const long MaxBytes = 1_000_000;

    private static readonly List<string> ProbeLog = new();
    private static string? _target;

    /// <summary>当前实际使用的日志文件（第一次写入时才确定）。</summary>
    public static string FilePath => _target ?? Candidates().First();

    /// <summary>探测过程的可读摘要：每个候选路径 + 成功/失败原因。</summary>
    public static string Diagnostic => string.Join(" | ", ProbeLog);

    /// <summary>最近一次写入失败的原因；null 表示至今都写成功了。</summary>
    public static string? LastError { get; private set; }

    private static IEnumerable<string> Candidates()
    {
        // 首选：%LOCALAPPDATA%（和 window.json 同一个目录，卸载时一起清）。
        yield return Path.Combine(LocalAppDataFolder(), "DshWsxPanel", "panel.log");
        // 退路 1：exe 旁边。exe 能跑就说明这个目录至少是可读的，通常也可写。
        yield return Path.Combine(AppContext.BaseDirectory, "WsxPanel.log");
        // 退路 2：%TEMP%。
        yield return Path.Combine(Path.GetTempPath(), "DshWsxPanel", "panel.log");
    }

    /// <summary>%LOCALAPPDATA% 的可靠解析：拿不到就按用户目录自己拼。</summary>
    public static string LocalAppDataFolder()
    {
        string? local = null;
        try
        {
            local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        }
        catch
        {
            // 受限环境里可能直接抛。
        }
        if (string.IsNullOrWhiteSpace(local)) local = Environment.GetEnvironmentVariable("LOCALAPPDATA");
        if (string.IsNullOrWhiteSpace(local))
        {
            string profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            if (!string.IsNullOrWhiteSpace(profile)) local = Path.Combine(profile, "AppData", "Local");
        }
        if (string.IsNullOrWhiteSpace(local)) local = AppContext.BaseDirectory;
        return local;
    }

    /// <summary>确定目标文件（只做一次）。任何情况下都不抛异常。</summary>
    private static void EnsureTarget()
    {
        if (_target is not null) return;

        foreach (string candidate in Candidates())
        {
            try
            {
                string dir = Path.GetDirectoryName(candidate)!;
                Directory.CreateDirectory(dir);
                // 真开一次才算数：ACL 拒绝、被独占、只读属性都在这一步暴露。
                using (new FileStream(candidate, FileMode.Append, FileAccess.Write, FileShare.ReadWrite)) { }
                _target = candidate;
                ProbeLog.Add($"{candidate} = ok");
                return;
            }
            catch (Exception ex)
            {
                ProbeLog.Add($"{candidate} = {ex.GetType().Name}: {ex.Message}");
            }
        }

        ProbeLog.Add("没有任何可写候选（日志功能禁用）");
    }

    /// <summary>由 --dump-status 调用：把探测摘要交出来，方便排查。</summary>
    public static string Probe()
    {
        try
        {
            lock (Gate) { EnsureTarget(); }
        }
        catch
        {
            // ignore
        }
        return Diagnostic;
    }

    public static void Write(string message)
    {
        try
        {
            lock (Gate)
            {
                EnsureTarget();
                if (_target is null) return;

                var info = new FileInfo(_target);
                if (info.Exists && info.Length > MaxBytes) info.Delete();

                string line = $"{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff} [{Environment.ProcessId}] {message}{Environment.NewLine}";
                File.AppendAllText(_target, line, Encoding.UTF8);
                LastError = null;
            }
        }
        catch (Exception ex)
        {
            // 写不进去就算了 —— 但把原因记住，别让「没有日志」变成新的谜团。
            LastError = $"{ex.GetType().Name}: {ex.Message}";
        }
    }

    public static void Error(string context, Exception ex)
        => Write($"错误 {context}：{ex.GetType().Name}: {ex.Message}{Environment.NewLine}{ex.StackTrace}");
}

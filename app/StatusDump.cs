using System.Text;

namespace DshWsxPanel;

/// <summary>
/// <c>--dump-status</c>：不开窗口、不碰任何 WinUI 类型，读一次状态文件，
/// 把「状态栏那一行」打到 stdout。
///
/// 这条路径的用处：UI 不好自动断言（截屏比对很脆），但状态栏的文案与判定逻辑
/// 是纯函数。把它暴露成一个可脚本化的命令后，就能真的对缺失文件 / 坏 JSON
/// 断言「状态栏会说什么」，而不是只确认「进程没崩」。它对窗口也完全无害。
/// </summary>
public static class StatusDump
{
    public static int Run(AppOptions options)
    {
        var output = new StringBuilder();
        int exitCode;

        // 顺手写一行日志并把它自己的状态报出来：headless 路径是排查
        // 「窗口到底有没有启动/有没有写日志」时唯一能拿到的旁证。
        Log.Write($"--dump-status state={options.StatePath}");
        string? logError = Log.LastError;
        string logDiagnostic = Log.Probe();
        string placementProbe = WindowPlacement.ProbeWritable();

        bool ok = StateFileReader.TryRead(options.StatePath, out var snapshot, out var error);

        ConnectionState state;
        string? detail;
        HostInfo? host = null;
        long ageMs = 0;
        int targets = 0, online = 0, offline = 0, probing = 0, unknown = 0, failing = 0;
        bool stopped = false;
        var counts = default(SummaryCounts);
        bool haveCounts = false;

        if (ok && snapshot is not null)
        {
            host = snapshot.Host;
            stopped = host?.Stopped == true;
            targets = snapshot.Targets.Count;
            foreach (var t in snapshot.Targets)
            {
                switch (t.Status)
                {
                    case TargetStatus.Online: online++; break;
                    case TargetStatus.Offline: offline++; break;
                    case TargetStatus.Probing: probing++; break;
                    default: unknown++; break;
                }
            }
            failing = snapshot.Errors.Count;

            // 头部摘要：和窗口走同一个 Summary，所以这里断言到的就是界面上的那一行。
            counts = Summary.Count(snapshot);
            haveCounts = true;

            long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            long freshAt = snapshot.GeneratedAt > 0 ? snapshot.GeneratedAt : now;
            ageMs = Math.Max(0, now - freshAt);

            state = stopped ? ConnectionState.HostStopped
                  : ageMs > options.StaleSeconds * 1000L ? ConnectionState.Stale
                  : ConnectionState.Live;
            detail = null;
            exitCode = 0;
        }
        else
        {
            detail = error?.Message ?? "未知错误";
            state = error?.Kind switch
            {
                StateErrorKind.Missing => ConnectionState.Missing,
                StateErrorKind.Io => ConnectionState.IoError,
                _ => ConnectionState.ParseError,
            };
            exitCode = error?.Kind switch
            {
                StateErrorKind.Missing => 2,
                StateErrorKind.Io => 4,
                _ => 3,
            };
        }

        var info = new StatusInfo(state, options.StatePath, options.StaleSeconds, ageMs, detail, host);
        string line = StatusText.Line(info);

        void Emit(string key, string value) => output.Append(key).Append('=').Append(Flatten(value)).Append('\n');

        Emit("state", StateName(state));
        Emit("exitCode", exitCode.ToString());
        Emit("line", line);
        Emit("statePath", options.StatePath);
        Emit("staleSeconds", options.StaleSeconds.ToString());
        Emit("ageMs", ageMs.ToString());
        Emit("targets", targets.ToString());
        Emit("online", online.ToString());
        Emit("offline", offline.ToString());
        Emit("probing", probing.ToString());
        Emit("unknown", unknown.ToString());
        Emit("errors", failing.ToString());
        Emit("hostStopped", stopped ? "true" : "false");
        Emit("hostPid", (host?.Pid ?? 0).ToString());
        Emit("pluginVersion", host?.PluginVersion ?? "");
        Emit("emptyText", StatusText.Empty(info, targets) ?? "");
        // 头部摘要那一行（以及它的分段文案）。窗口用的是同一个 Summary，
        // 所以断言这几项就等于断言标题栏下方那一行。
        Emit("header", haveCounts ? Summary.HeaderText(counts) : "");
        Emit("failingText", haveCounts ? Summary.FailingText(counts) : "");
        Emit("probingText", haveCounts ? Summary.ProbingText(counts) : "");
        Emit("dockerSummaryText", haveCounts ? Summary.DockerSummaryText(counts) : "");
        Emit("onlineCounted", haveCounts ? counts.Online.ToString() : "0");
        Emit("logPath", Log.FilePath);
        Emit("logProbe", logDiagnostic);
        Emit("logError", logError ?? "");
        Emit("placementPath", WindowPlacement.FilePath);
        Emit("placementProbe", placementProbe);
        Emit("detail", detail ?? "");

        WriteStdout(output.ToString());
        return exitCode;
    }

    /// <summary>
    /// 往 stdout 写**明确的 UTF-8 字节**（无 BOM）。
    ///
    /// 不能图省事用 Console.Out.Write：这是个 WinExe（GUI 子系统）进程，
    /// 没有控制台时 Console.OutputEncoding 取到的不是 UTF-8，中文会以别的代码页
    /// 写出去，调用方按 UTF-8 解码就是一堆乱码 —— 脚本里对状态文本的断言全都匹配不上。
    /// 自己拿标准输出流写，编码就完全确定了。
    /// </summary>
    private static void WriteStdout(string text)
    {
        try
        {
            using var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
            stdout.Write(text);
            stdout.Flush();
        }
        catch
        {
            // 没有 stdout（双击启动、或句柄无效）就算了 —— dump 模式本来就是给脚本用的。
        }
    }

    private static string StateName(ConnectionState state) => state switch
    {
        ConnectionState.Live => "live",
        ConnectionState.Missing => "missing",
        ConnectionState.ParseError => "parse-error",
        ConnectionState.IoError => "io-error",
        ConnectionState.Stale => "stale",
        ConnectionState.HostStopped => "host-stopped",
        _ => "waiting",
    };

    /// <summary>一行一个 key=value，所以值里的换行必须压掉（空状态文案本来就是多行的）。</summary>
    private static string Flatten(string value)
        => value.Replace("\r\n", " \\n ").Replace('\n', ' ').Replace('\r', ' ').Trim();
}

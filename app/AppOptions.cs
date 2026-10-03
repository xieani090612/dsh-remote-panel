using System.IO;

namespace DshWsxPanel;

/// <summary>命令行 + 环境变量选项。宿主插件拉起窗口时按这套参数传。</summary>
public sealed class AppOptions
{
    /// <summary>状态文件路径（插件写入、本程序只读）。</summary>
    public string StatePath { get; init; } = DefaultStatePath();

    /// <summary>快照连续多久没有更新就判定宿主心跳丢失（秒）。</summary>
    public int StaleSeconds { get; init; } = 15;

    /// <summary>心跳丢失后多久自动关窗（秒）；0 = 永不自动关闭（手工启动时的默认值）。</summary>
    public int ExitAfterStaleSeconds { get; init; }

    /// <summary>--topmost：强制置顶；null = 用 window.json 里记住的值。</summary>
    public bool? Topmost { get; init; }

    /// <summary>--compact：强制精简；null = 用 window.json 里记住的值。</summary>
    public bool? Compact { get; init; }

    /// <summary>--dump-status：不开窗口，读一次状态文件，把结果打到 stdout 后退出。</summary>
    public bool DumpStatus { get; init; }

    /// <summary>--help</summary>
    public bool Help { get; init; }

    public static AppOptions Default { get; } = new();

    public const string Usage = """
        用法：WsxPanel.exe [选项]

          --state <路径>          状态文件（默认 %USERPROFILE%\.dsh\remote-panel\state.json）
          --stale-seconds <n>     多久没有新快照就判定心跳丢失，默认 15
          --exit-after-stale <n>  心跳丢失后多久自动关窗，0 = 永不（插件拉起时传 90）
          --topmost               强制窗口置顶（默认沿用上次记住的值）
          --no-topmost            强制不置顶
          --compact               强制精简模式（压缩次要区块）
          --no-compact            强制完整模式
          --dump-status           无界面：读一次状态文件，把状态打到 stdout 后退出
                                  退出码 0=正常 2=文件不存在 3=解析/结构错 4=读取失败
          -h, --help              显示本帮助

        环境变量：
          DSH_WSX_STATE           状态文件路径（优先级低于 --state）
          DSH_WSX_STALE_SECONDS   心跳阈值（优先级低于 --stale-seconds）
        """;

    public static AppOptions Parse(string[] args)
    {
        string statePath = DefaultStatePath();
        int stale = DefaultStaleSeconds();
        int exitAfter = 0;
        bool? topmost = null;
        bool? compact = null;
        bool dump = false;
        bool help = false;

        for (int i = 0; i < args.Length; i++)
        {
            string arg = args[i];
            string? Next() => i + 1 < args.Length ? args[++i] : null;

            switch (arg)
            {
                case "--state" or "-s":
                {
                    string? value = Next();
                    if (!string.IsNullOrWhiteSpace(value)) statePath = value!;
                    break;
                }
                case "--stale-seconds":
                {
                    string? value = Next();
                    if (int.TryParse(value, out int parsed) && parsed > 0) stale = parsed;
                    break;
                }
                case "--exit-after-stale":
                {
                    string? value = Next();
                    if (int.TryParse(value, out int parsed) && parsed >= 0) exitAfter = parsed;
                    break;
                }
                case "--topmost":
                    topmost = true;
                    break;
                case "--no-topmost":
                    topmost = false;
                    break;
                case "--compact":
                    compact = true;
                    break;
                case "--no-compact":
                    compact = false;
                    break;
                case "--dump-status":
                    // 允许 --dump-status <path> 这种简写；不带值就用 --state / 默认路径。
                    dump = true;
                    if (i + 1 < args.Length && !args[i + 1].StartsWith('-')
                        && args[i + 1].EndsWith(".json", StringComparison.OrdinalIgnoreCase))
                    {
                        statePath = args[++i];
                    }
                    break;
                case "-h" or "--help" or "-?":
                    help = true;
                    break;
                default:
                    // 允许直接丢一个路径进来：WsxPanel.exe D:\tmp\state.json
                    if (!arg.StartsWith('-') && arg.EndsWith(".json", StringComparison.OrdinalIgnoreCase))
                    {
                        statePath = arg;
                    }
                    break;
            }
        }

        return new AppOptions
        {
            StatePath = SafeFullPath(statePath),
            StaleSeconds = stale,
            ExitAfterStaleSeconds = exitAfter,
            Topmost = topmost,
            Compact = compact,
            DumpStatus = dump,
            Help = help,
        };
    }

    /// <summary>GetFullPath 对非法路径会抛异常；这里退回到原样字符串，让状态栏去报「文件不存在」。</summary>
    private static string SafeFullPath(string path)
    {
        try
        {
            return Path.GetFullPath(path);
        }
        catch
        {
            return path;
        }
    }

    /// <summary>
    /// 默认状态文件。优先级：--state &gt; DSH_WSX_STATE &gt; $DSH_HOME\remote-panel\state.json
    /// &gt; %USERPROFILE%\.dsh\remote-panel\state.json。
    ///
    /// 注意这里是**环境变量作为默认值、命令行覆盖它**。参考 HUD 是先解析命令行、
    /// 再用环境变量无条件覆盖，结果是「--state 明明传了却不生效」——这里不再那样做。
    /// </summary>
    private static string DefaultStatePath()
    {
        string? env = Environment.GetEnvironmentVariable("DSH_WSX_STATE");
        if (!string.IsNullOrWhiteSpace(env)) return env!;

        string dshHome = Environment.GetEnvironmentVariable("DSH_HOME") is { Length: > 0 } home
            ? home
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".dsh");
        return Path.Combine(dshHome, "remote-panel", "state.json");
    }

    private static int DefaultStaleSeconds()
    {
        string? env = Environment.GetEnvironmentVariable("DSH_WSX_STALE_SECONDS");
        return int.TryParse(env, out int parsed) && parsed > 0 ? parsed : 15;
    }
}

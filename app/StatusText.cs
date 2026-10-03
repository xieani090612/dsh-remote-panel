namespace DshWsxPanel;

/// <summary>面板对「状态文件」这件事的总体判断。决定状态栏与空状态文案。</summary>
public enum ConnectionState
{
    /// <summary>还没读到过任何一份快照，也还没失败。</summary>
    Waiting,
    /// <summary>刚读到一份新鲜快照。</summary>
    Live,
    /// <summary>文件不存在。</summary>
    Missing,
    /// <summary>文件在，但语法或结构不对。</summary>
    ParseError,
    /// <summary>文件在，但读不出来（被独占、权限不足……）。</summary>
    IoError,
    /// <summary>读到过，但已经超过 staleSeconds 没有新快照 —— 宿主心跳丢了。</summary>
    Stale,
    /// <summary>插件 dispose() 写的最后一帧：宿主是正常收尾的，不要报成超时。</summary>
    HostStopped,
}

/// <summary>状态栏要显示的全部输入。窗口与 headless 路径都构造它，再走同一个 Line()。</summary>
public readonly record struct StatusInfo(
    ConnectionState State,
    string Path,
    int StaleSeconds,
    long AgeMs,
    string? Detail,
    HostInfo? Host);

/// <summary>
/// 连接状态 → 文案。**唯一**一处产生这些字符串的地方，所以断言这些文本
/// 就等于断言状态栏（--dump-status 打印的就是 Line() 的返回值）。
/// </summary>
public static class StatusText
{
    /// <summary>状态栏那一行。</summary>
    public static string Line(StatusInfo s) => s.State switch
    {
        ConnectionState.Live => LiveLine(s),
        // Missing / IoError 的 Detail 里已经带了完整措辞（含路径），直接原样显示。
        ConnectionState.Missing => s.Detail ?? $"状态文件不存在：{s.Path}",
        ConnectionState.IoError => s.Detail ?? $"状态文件读取失败：{s.Path}",
        ConnectionState.ParseError => $"状态文件解析失败：{s.Detail}",
        ConnectionState.Stale =>
            $"宿主心跳丢失：已 {Format.Age(s.AgeMs)} 没有新快照（阈值 {s.StaleSeconds}s）",
        ConnectionState.HostStopped => "宿主已退出：插件 dispose 时写下了最后一帧快照",
        _ => $"等待第一份快照…（{s.Path}）",
    };

    private static string LiveLine(StatusInfo s)
    {
        var host = s.Host;
        return Format.Join(
            "已连接",
            $"更新于 {Format.Age(s.AgeMs)} 前",
            host is null ? null : $"宿主 pid {host.Pid}",
            string.IsNullOrWhiteSpace(host?.PluginVersion) ? null : $"插件 v{host!.PluginVersion}",
            host?.Revision is long rev ? $"快照 #{rev}" : null);
    }

    /// <summary>
    /// 内容区为空时的那段说明。只要还有目标卡片就返回 null ——
    /// 已经拿到过数据之后，宁可留着「最后一次已知状态」（每张卡片上的
    /// 「多久以前探测的」会自己长大），也不要把它换成一块空白。
    /// 这里比状态栏多写几句：状态栏只有一行，说不清「该怎么办」。
    /// </summary>
    public static string? Empty(StatusInfo s, int targetCount)
    {
        if (targetCount > 0) return null;

        return s.State switch
        {
            ConnectionState.Missing =>
                "找不到状态文件\n\n"
                + s.Path + "\n\n"
                + "启动 DSH 并启用 dsh-remote-panel 插件后，这里会自动开始刷新。",

            ConnectionState.ParseError =>
                "状态文件无法解析\n\n"
                + s.Detail + "\n\n"
                + "文件：" + s.Path,

            ConnectionState.IoError =>
                "状态文件读不出来\n\n"
                + s.Detail + "\n\n"
                + "文件：" + s.Path,

            ConnectionState.Stale =>
                "宿主心跳丢失\n\n"
                + $"已 {Format.Age(s.AgeMs)} 没有收到新快照（阈值 {s.StaleSeconds}s）。\n"
                + "DSH 可能已退出，或插件被停用了。",

            ConnectionState.HostStopped =>
                "宿主已退出\n\n插件 dispose 时写下了最后一帧快照。",

            ConnectionState.Live =>
                "快照里没有任何目标\n\n"
                + "检查 dsh-remote-panel 的 targets 配置。\n"
                + "文件：" + s.Path,

            _ => "正在等待第一份快照…\n\n" + s.Path,
        };
    }
}

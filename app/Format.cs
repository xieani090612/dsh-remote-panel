using System.Globalization;

namespace DshWsxPanel;

/// <summary>
/// 纯格式化工具。刻意不引用任何 WinUI 类型 —— headless 的 --dump-status 路径
/// 与窗口共用它，两者输出的文本必须逐字节一致。
/// </summary>
public static class Format
{
    /// <summary>字节数按 1024 进制取一个人类可读单位。null → "—"。</summary>
    public static string Bytes(long? bytes)
    {
        if (bytes is not long b) return "—";
        if (b < 0) b = 0;
        const double Kb = 1024, Mb = Kb * 1024, Gb = Mb * 1024, Tb = Gb * 1024;
        double v = b;
        if (v >= Tb) return (v / Tb).ToString("0.00", CultureInfo.InvariantCulture) + " TB";
        if (v >= Gb) return (v / Gb).ToString("0.0", CultureInfo.InvariantCulture) + " GB";
        if (v >= Mb) return (v / Mb).ToString("0", CultureInfo.InvariantCulture) + " MB";
        if (v >= Kb) return (v / Kb).ToString("0", CultureInfo.InvariantCulture) + " KB";
        return b.ToString(CultureInfo.InvariantCulture) + " B";
    }

    /// <summary>「已用 / 总量」。两边都缺就只回一个 "—"。</summary>
    public static string BytesPair(long? used, long? total)
    {
        if (used is null && total is null) return "—";
        if (total is null) return Bytes(used);
        if (used is null) return "— / " + Bytes(total);
        return $"{Bytes(used)} / {Bytes(total)}";
    }

    /// <summary>百分比保留一位小数，但不显示无意义的 ".0"。</summary>
    public static string Percent(double? percent)
    {
        if (percent is not double p) return "—";
        if (double.IsNaN(p) || double.IsInfinity(p)) return "—";
        return p.ToString("0.#", CultureInfo.InvariantCulture) + "%";
    }

    /// <summary>CPU 的三个 load 平均值，两端留空时给 "—"。</summary>
    public static string Load(double? l1, double? l5, double? l15)
    {
        if (l1 is null && l5 is null && l15 is null) return "—";
        return $"{Load1(l1)} / {Load1(l5)} / {Load1(l15)}";
    }

    private static string Load1(double? v)
        => v is double d && !double.IsNaN(d) ? d.ToString("0.00", CultureInfo.InvariantCulture) : "—";

    /// <summary>一次探测的往返耗时。小于 1s 用毫秒，超过就用秒。</summary>
    public static string Latency(long? ms)
    {
        if (ms is not long v) return "—";
        if (v < 0) v = 0;
        if (v < 1000) return v + " ms";
        if (v < 60_000) return (v / 1000.0).ToString("0.0", CultureInfo.InvariantCulture) + " s";
        return TimeSpan.FromMilliseconds(v).ToString(@"m\:ss", CultureInfo.InvariantCulture);
    }

    /// <summary>「多久之前」的紧凑写法，调用方自己加「前」。</summary>
    public static string Age(long ms)
    {
        if (ms < 0) ms = 0;
        if (ms < 400) return "刚刚";
        if (ms < 60_000) return (ms / 1000.0).ToString("0.0", CultureInfo.InvariantCulture) + "s";
        if (ms < 3_600_000) return (ms / 60_000).ToString("0", CultureInfo.InvariantCulture) + " 分钟";
        if (ms < 86_400_000) return (ms / 3_600_000.0).ToString("0.0", CultureInfo.InvariantCulture) + " 小时";
        return (ms / 86_400_000.0).ToString("0.0", CultureInfo.InvariantCulture) + " 天";
    }

    /// <summary>系统已运行时长。</summary>
    public static string Uptime(long? seconds)
    {
        if (seconds is not long s || s <= 0) return "—";
        if (s < 3600) return (s / 60) + " 分钟";
        if (s < 86_400) return $"{s / 3600} 小时 {s % 3600 / 60} 分";
        return $"{s / 86_400} 天 {s % 86_400 / 3600} 小时";
    }

    /// <summary>把多段可缺省文本用「 · 」拼起来，自动丢掉空段。</summary>
    public static string Join(params string?[] parts)
        => string.Join(" · ", parts.Where(p => !string.IsNullOrWhiteSpace(p)));
}

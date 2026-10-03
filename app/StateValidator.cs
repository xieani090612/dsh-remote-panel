using System.Text.Json;

namespace DshWsxPanel;

/// <summary>
/// 对状态文件做一遍**带具体 JSON 路径**的结构校验，然后再交给
/// System.Text.Json 反序列化。
///
/// 为什么要有这一层：单靠 JsonSerializer 只能发现「类型不对」，发现不了
/// 「必填字段缺失」——缺字段时属性会安静地落回默认值，窗口就渲染成一片空白，
/// 完全看不出发生了什么。这一层把失败原因钉到具体字段上，
/// 例如 <c>$."targets"[1]."status"：未知状态 "down"（应为 online / offline / probing / unknown）</c>，
/// 状态栏直接把它显示出来。
///
/// 宽松之处（刻意的）：**可缺省**字段如果是 JSON null，按「没写」处理，不算错误 ——
/// 插件用 null 表示「这次没采集到」很常见，把它当成 schema 违规会让面板
/// 因为一份完全能渲染的文档而报解析失败。必填字段为 null 仍然算错。
///
/// 本文件不引用任何 WinUI 类型，所以能被 headless 路径（--dump-status）复用。
/// </summary>
public static class StateValidator
{
    private const string Root = "$";

    /// <summary>校验通过返回 null；否则返回一条带路径的中文错误。</summary>
    public static string? Validate(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Object)
        {
            return $"{Root}：顶层必须是 JSON 对象，实际是 {Name(root.ValueKind)}";
        }

        // ---- 必填：schema（必须是 1） ----
        string? e = Require(root, Root, "schema", JsonValueKind.Number, out var schemaEl);
        if (e is not null) return e;
        if (!schemaEl.TryGetInt32(out int schema))
        {
            return $"{Root}.\"schema\"：期望整数，实际是 {schemaEl.GetRawText()}";
        }
        if (schema != 1)
        {
            return $"{Root}.\"schema\"：期望 1，实际是 {schema}（本面板只认 schema 1）";
        }

        // ---- 必填：generatedAt（Unix 毫秒，读取方据此判断宿主是否还在） ----
        e = Require(root, Root, "generatedAt", JsonValueKind.Number, out var genEl);
        if (e is not null) return e;
        if (!genEl.TryGetInt64(out _))
        {
            return $"{Root}.\"generatedAt\"：期望整数（Unix 毫秒），实际是 {genEl.GetRawText()}";
        }

        // ---- 必填：host ----
        e = Require(root, Root, "host", JsonValueKind.Object, out var hostEl);
        if (e is not null) return e;
        e = ValidateHost(hostEl, $"{Root}.\"host\"");
        if (e is not null) return e;

        // ---- 必填：totals ----
        e = Require(root, Root, "totals", JsonValueKind.Object, out var totalsEl);
        if (e is not null) return e;
        e = ValidateTotals(totalsEl, $"{Root}.\"totals\"");
        if (e is not null) return e;

        // ---- 必填：targets ----
        e = Require(root, Root, "targets", JsonValueKind.Array, out var targetsEl);
        if (e is not null) return e;
        // id 重复是真实会发生的配置错误（两个目标取了同一个 slug），而且症状很隐蔽：
        // 面板会把它们合成同一张卡片。宁可在校验期直接报出来。
        var seenIds = new HashSet<string>(StringComparer.Ordinal);
        int index = 0;
        foreach (var target in targetsEl.EnumerateArray())
        {
            string path = $"{Root}.\"targets\"[{index}]";
            e = ValidateTarget(target, path);
            if (e is not null) return e;
            if (target.TryGetProperty("id", out var idEl) && idEl.ValueKind == JsonValueKind.String)
            {
                string id = idEl.GetString() ?? "";
                if (!seenIds.Add(id))
                {
                    return $"{path}.\"id\"：目标 id \"{id}\" 重复（每个目标的 id 必须唯一）";
                }
            }
            index++;
        }

        // ---- 可选：errors（面板顶部的告警条） ----
        if (root.TryGetProperty("errors", out var errorsEl) && errorsEl.ValueKind != JsonValueKind.Null)
        {
            if (errorsEl.ValueKind != JsonValueKind.Array)
            {
                return TypeError($"{Root}.\"errors\"", JsonValueKind.Array, errorsEl.ValueKind);
            }
            int i = 0;
            foreach (var item in errorsEl.EnumerateArray())
            {
                string p = $"{Root}.\"errors\"[{i}]";
                if (item.ValueKind != JsonValueKind.Object)
                {
                    return TypeError(p, JsonValueKind.Object, item.ValueKind);
                }
                e = Opt(item, p, "targetId", JsonValueKind.String);
                if (e is not null) return e;
                e = Opt(item, p, "name", JsonValueKind.String);
                if (e is not null) return e;
                e = Opt(item, p, "error", JsonValueKind.String);
                if (e is not null) return e;
                e = OptNum(item, p, "at", integer: true);
                if (e is not null) return e;
                e = OptNum(item, p, "consecutiveFailures", integer: true);
                if (e is not null) return e;
                i++;
            }
        }

        return null;
    }

    // ------------------------------------------------------------------
    // 各级子结构
    // ------------------------------------------------------------------

    private static string? ValidateHost(JsonElement host, string p)
    {
        string? e = Require(host, p, "pid", JsonValueKind.Number, out var pidEl);
        if (e is not null) return e;
        if (!pidEl.TryGetInt32(out _))
        {
            return $"{p}.\"pid\"：期望整数，实际是 {pidEl.GetRawText()}";
        }

        e = Require(host, p, "pluginVersion", JsonValueKind.String, out _);
        if (e is not null) return e;
        e = Require(host, p, "stateFile", JsonValueKind.String, out _);
        if (e is not null) return e;

        e = Opt(host, p, "dshHome", JsonValueKind.String);
        if (e is not null) return e;
        e = Opt(host, p, "platform", JsonValueKind.String);
        if (e is not null) return e;
        e = Opt(host, p, "error", JsonValueKind.String);
        if (e is not null) return e;
        e = OptNum(host, p, "startedAt", integer: true);
        if (e is not null) return e;
        e = OptNum(host, p, "revision", integer: true);
        if (e is not null) return e;
        e = OptBool(host, p, "stopped");
        if (e is not null) return e;

        return null;
    }

    private static string? ValidateTotals(JsonElement totals, string p)
    {
        foreach (string name in new[] { "targets", "online", "offline", "probing", "unknown", "dockerRunning" })
        {
            string? e = OptNum(totals, p, name, integer: true);
            if (e is not null) return e;
        }
        return null;
    }

    private static string? ValidateTarget(JsonElement t, string p)
    {
        if (t.ValueKind != JsonValueKind.Object)
        {
            return TypeError(p, JsonValueKind.Object, t.ValueKind);
        }

        string? e = Require(t, p, "id", JsonValueKind.String, out _);
        if (e is not null) return e;
        e = Require(t, p, "name", JsonValueKind.String, out _);
        if (e is not null) return e;

        e = Require(t, p, "kind", JsonValueKind.String, out var kindEl);
        if (e is not null) return e;
        string kind = kindEl.GetString() ?? "";
        if (kind != TargetKind.Wsl && kind != TargetKind.Ssh)
        {
            return $"{p}.\"kind\"：未知目标类型 \"{kind}\"（应为 {TargetKind.Wsl} / {TargetKind.Ssh}）";
        }

        e = Require(t, p, "status", JsonValueKind.String, out var statusEl);
        if (e is not null) return e;
        string status = statusEl.GetString() ?? "";
        if (status != TargetStatus.Online && status != TargetStatus.Offline
            && status != TargetStatus.Probing && status != TargetStatus.Unknown)
        {
            return $"{p}.\"status\"：未知状态 \"{status}\""
                 + $"（应为 {TargetStatus.Online} / {TargetStatus.Offline} / {TargetStatus.Probing} / {TargetStatus.Unknown}）";
        }

        e = Opt(t, p, "host", JsonValueKind.String);
        if (e is not null) return e;
        e = Opt(t, p, "user", JsonValueKind.String);
        if (e is not null) return e;
        e = Opt(t, p, "error", JsonValueKind.String);
        if (e is not null) return e;
        foreach (string name in new[] { "port", "latencyMs", "lastProbeAt", "lastOnlineAt", "nextProbeAt", "consecutiveFailures" })
        {
            e = OptNum(t, p, name, integer: true);
            if (e is not null) return e;
        }
        e = OptBool(t, p, "enabled");
        if (e is not null) return e;
        e = OptBool(t, p, "woke");
        if (e is not null) return e;

        // tags: string[]
        if (t.TryGetProperty("tags", out var tagsEl) && tagsEl.ValueKind != JsonValueKind.Null)
        {
            if (tagsEl.ValueKind != JsonValueKind.Array)
            {
                return TypeError($"{p}.\"tags\"", JsonValueKind.Array, tagsEl.ValueKind);
            }
            int i = 0;
            foreach (var tag in tagsEl.EnumerateArray())
            {
                if (tag.ValueKind != JsonValueKind.String)
                {
                    return TypeError($"{p}.\"tags\"[{i}]", JsonValueKind.String, tag.ValueKind);
                }
                i++;
            }
        }

        // facts：静态身份，采集一次就缓存
        if (t.TryGetProperty("facts", out var factsEl) && factsEl.ValueKind != JsonValueKind.Null)
        {
            if (factsEl.ValueKind != JsonValueKind.Object)
            {
                return TypeError($"{p}.\"facts\"", JsonValueKind.Object, factsEl.ValueKind);
            }
            string fp = $"{p}.\"facts\"";
            foreach (string name in new[] { "hostname", "os", "kernel", "arch", "cpuModel", "distro" })
            {
                e = Opt(factsEl, fp, name, JsonValueKind.String);
                if (e is not null) return e;
            }
            e = OptNum(factsEl, fp, "cpuCount", integer: true);
            if (e is not null) return e;
            e = OptNum(factsEl, fp, "uptimeSec", integer: true);
            if (e is not null) return e;
            e = OptBool(factsEl, fp, "wsl");
            if (e is not null) return e;
        }

        // metrics（schema 允许 null：这次没采到）
        if (t.TryGetProperty("metrics", out var metricsEl) && metricsEl.ValueKind != JsonValueKind.Null)
        {
            e = ValidateMetrics(metricsEl, $"{p}.\"metrics\"");
            if (e is not null) return e;
        }

        // history：滚动 sparkline 采样
        if (t.TryGetProperty("history", out var historyEl) && historyEl.ValueKind != JsonValueKind.Null)
        {
            if (historyEl.ValueKind != JsonValueKind.Array)
            {
                return TypeError($"{p}.\"history\"", JsonValueKind.Array, historyEl.ValueKind);
            }
            int i = 0;
            foreach (var sample in historyEl.EnumerateArray())
            {
                string sp = $"{p}.\"history\"[{i}]";
                if (sample.ValueKind != JsonValueKind.Object)
                {
                    return TypeError(sp, JsonValueKind.Object, sample.ValueKind);
                }
                e = OptNum(sample, sp, "at", integer: true);
                if (e is not null) return e;
                e = OptNum(sample, sp, "cpuPercent");
                if (e is not null) return e;
                e = OptNum(sample, sp, "memPercent");
                if (e is not null) return e;
                e = OptNum(sample, sp, "latencyMs", integer: true);
                if (e is not null) return e;
                i++;
            }
        }

        return null;
    }

    private static string? ValidateMetrics(JsonElement m, string p)
    {
        if (m.ValueKind != JsonValueKind.Object)
        {
            return TypeError(p, JsonValueKind.Object, m.ValueKind);
        }

        string? e;

        if (m.TryGetProperty("cpu", out var cpuEl) && cpuEl.ValueKind != JsonValueKind.Null)
        {
            if (cpuEl.ValueKind != JsonValueKind.Object)
            {
                return TypeError($"{p}.\"cpu\"", JsonValueKind.Object, cpuEl.ValueKind);
            }
            string cp = $"{p}.\"cpu\"";
            foreach (string name in new[] { "usagePercent", "load1", "load5", "load15" })
            {
                e = OptNum(cpuEl, cp, name);
                if (e is not null) return e;
            }
        }

        if (m.TryGetProperty("memory", out var memEl) && memEl.ValueKind != JsonValueKind.Null)
        {
            if (memEl.ValueKind != JsonValueKind.Object)
            {
                return TypeError($"{p}.\"memory\"", JsonValueKind.Object, memEl.ValueKind);
            }
            string mp = $"{p}.\"memory\"";
            foreach (string name in new[] { "totalBytes", "usedBytes", "availableBytes", "swapTotalBytes", "swapUsedBytes" })
            {
                e = OptNum(memEl, mp, name, integer: true);
                if (e is not null) return e;
            }
            e = OptNum(memEl, mp, "usagePercent");
            if (e is not null) return e;
        }

        if (m.TryGetProperty("disks", out var disksEl) && disksEl.ValueKind != JsonValueKind.Null)
        {
            if (disksEl.ValueKind != JsonValueKind.Array)
            {
                return TypeError($"{p}.\"disks\"", JsonValueKind.Array, disksEl.ValueKind);
            }
            int i = 0;
            foreach (var disk in disksEl.EnumerateArray())
            {
                string dp = $"{p}.\"disks\"[{i}]";
                if (disk.ValueKind != JsonValueKind.Object)
                {
                    return TypeError(dp, JsonValueKind.Object, disk.ValueKind);
                }
                e = Require(disk, dp, "mount", JsonValueKind.String, out _);
                if (e is not null) return e;
                e = Require(disk, dp, "totalBytes", JsonValueKind.Number, out _);
                if (e is not null) return e;
                e = Require(disk, dp, "usedBytes", JsonValueKind.Number, out _);
                if (e is not null) return e;
                e = Opt(disk, dp, "fs", JsonValueKind.String);
                if (e is not null) return e;
                e = OptNum(disk, dp, "availableBytes", integer: true);
                if (e is not null) return e;
                e = OptNum(disk, dp, "usagePercent");
                if (e is not null) return e;
                i++;
            }
        }

        if (m.TryGetProperty("gpus", out var gpusEl) && gpusEl.ValueKind != JsonValueKind.Null)
        {
            if (gpusEl.ValueKind != JsonValueKind.Array)
            {
                return TypeError($"{p}.\"gpus\"", JsonValueKind.Array, gpusEl.ValueKind);
            }
            int i = 0;
            foreach (var gpu in gpusEl.EnumerateArray())
            {
                string gp = $"{p}.\"gpus\"[{i}]";
                if (gpu.ValueKind != JsonValueKind.Object)
                {
                    return TypeError(gp, JsonValueKind.Object, gpu.ValueKind);
                }
                e = OptNum(gpu, gp, "index", integer: true);
                if (e is not null) return e;
                e = Opt(gpu, gp, "name", JsonValueKind.String);
                if (e is not null) return e;
                foreach (string name in new[] { "memoryTotalBytes", "memoryUsedBytes" })
                {
                    e = OptNum(gpu, gp, name, integer: true);
                    if (e is not null) return e;
                }
                e = OptNum(gpu, gp, "utilizationPercent");
                if (e is not null) return e;
                e = OptNum(gpu, gp, "temperatureC");
                if (e is not null) return e;
                i++;
            }
        }

        // docker（schema 允许 null；null = 这台机器没有 docker CLI，和「docker 空闲」不是一回事）
        if (m.TryGetProperty("docker", out var dockerEl) && dockerEl.ValueKind != JsonValueKind.Null)
        {
            if (dockerEl.ValueKind != JsonValueKind.Object)
            {
                return TypeError($"{p}.\"docker\"", JsonValueKind.Object, dockerEl.ValueKind);
            }
            string dp = $"{p}.\"docker\"";
            e = OptBool(dockerEl, dp, "available");
            if (e is not null) return e;
            e = Opt(dockerEl, dp, "version", JsonValueKind.String);
            if (e is not null) return e;
            e = Opt(dockerEl, dp, "error", JsonValueKind.String);
            if (e is not null) return e;
            foreach (string name in new[] { "containers", "running", "paused", "stopped", "images" })
            {
                e = OptNum(dockerEl, dp, name, integer: true);
                if (e is not null) return e;
            }
        }

        if (m.TryGetProperty("processes", out var procEl) && procEl.ValueKind != JsonValueKind.Null)
        {
            if (procEl.ValueKind != JsonValueKind.Object)
            {
                return TypeError($"{p}.\"processes\"", JsonValueKind.Object, procEl.ValueKind);
            }
            string pp = $"{p}.\"processes\"";
            e = OptNum(procEl, pp, "total", integer: true);
            if (e is not null) return e;

            foreach (string listName in new[] { "topCpu", "topMem" })
            {
                if (!procEl.TryGetProperty(listName, out var listEl) || listEl.ValueKind == JsonValueKind.Null) continue;
                if (listEl.ValueKind != JsonValueKind.Array)
                {
                    return TypeError($"{pp}.\"{listName}\"", JsonValueKind.Array, listEl.ValueKind);
                }
                int i = 0;
                foreach (var proc in listEl.EnumerateArray())
                {
                    string ip = $"{pp}.\"{listName}\"[{i}]";
                    if (proc.ValueKind != JsonValueKind.Object)
                    {
                        return TypeError(ip, JsonValueKind.Object, proc.ValueKind);
                    }
                    e = OptNum(proc, ip, "pid", integer: true);
                    if (e is not null) return e;
                    e = Opt(proc, ip, "user", JsonValueKind.String);
                    if (e is not null) return e;
                    e = OptNum(proc, ip, "cpuPercent");
                    if (e is not null) return e;
                    e = OptNum(proc, ip, "memPercent");
                    if (e is not null) return e;
                    e = Opt(proc, ip, "command", JsonValueKind.String);
                    if (e is not null) return e;
                    i++;
                }
            }
        }

        if (m.TryGetProperty("services", out var svcEl) && svcEl.ValueKind != JsonValueKind.Null)
        {
            if (svcEl.ValueKind != JsonValueKind.Array)
            {
                return TypeError($"{p}.\"services\"", JsonValueKind.Array, svcEl.ValueKind);
            }
            int i = 0;
            foreach (var svc in svcEl.EnumerateArray())
            {
                string sp = $"{p}.\"services\"[{i}]";
                if (svc.ValueKind != JsonValueKind.Object)
                {
                    return TypeError(sp, JsonValueKind.Object, svc.ValueKind);
                }
                e = Opt(svc, sp, "name", JsonValueKind.String);
                if (e is not null) return e;
                e = Opt(svc, sp, "active", JsonValueKind.String);
                if (e is not null) return e;
                e = Opt(svc, sp, "sub", JsonValueKind.String);
                if (e is not null) return e;
                i++;
            }
        }

        return null;
    }

    // ------------------------------------------------------------------
    // 小工具
    // ------------------------------------------------------------------

    /// <summary>必填字段 + 类型检查。</summary>
    private static string? Require(JsonElement obj, string p, string name, JsonValueKind kind, out JsonElement value)
    {
        value = default;
        if (!obj.TryGetProperty(name, out var v))
        {
            return $"{p}：缺少必填字段 \"{name}\"";
        }
        if (v.ValueKind != kind)
        {
            return TypeError($"{p}.\"{name}\"", kind, v.ValueKind);
        }
        value = v;
        return null;
    }

    /// <summary>可缺省字段：JSON null 按「没写」处理，不算错误。</summary>
    private static string? Opt(JsonElement obj, string p, string name, JsonValueKind kind)
    {
        if (!obj.TryGetProperty(name, out var v)) return null;
        if (v.ValueKind == JsonValueKind.Null || v.ValueKind == kind) return null;
        return $"{p}.\"{name}\"：期望 {Name(kind)}，实际是 {Name(v.ValueKind)}";
    }

    /// <summary>可缺省布尔字段（true / false 都算对）。</summary>
    private static string? OptBool(JsonElement obj, string p, string name)
    {
        if (!obj.TryGetProperty(name, out var v)) return null;
        if (v.ValueKind is JsonValueKind.Null or JsonValueKind.True or JsonValueKind.False) return null;
        return $"{p}.\"{name}\"：期望 布尔值，实际是 {Name(v.ValueKind)}";
    }

    /// <summary>可缺省数值字段。integer=true 时还要能塞进 long。</summary>
    private static string? OptNum(JsonElement obj, string p, string name, bool integer = false)
    {
        if (!obj.TryGetProperty(name, out var v)) return null;
        if (v.ValueKind == JsonValueKind.Null) return null;
        if (v.ValueKind != JsonValueKind.Number)
        {
            return TypeError($"{p}.\"{name}\"", JsonValueKind.Number, v.ValueKind);
        }
        if (integer && !v.TryGetInt64(out _))
        {
            return $"{p}.\"{name}\"：期望整数，实际是 {v.GetRawText()}";
        }
        return null;
    }

    private static string TypeError(string path, JsonValueKind expected, JsonValueKind actual)
        => $"{path}：期望 {Name(expected)}，实际是 {Name(actual)}";

    internal static string Name(JsonValueKind kind) => kind switch
    {
        JsonValueKind.Object => "对象",
        JsonValueKind.Array => "数组",
        JsonValueKind.String => "字符串",
        JsonValueKind.Number => "数字",
        JsonValueKind.True or JsonValueKind.False => "布尔值",
        JsonValueKind.Null => "null",
        _ => "未知类型",
    };
}

using System.IO;
using System.Text.Json;

namespace DshWsxPanel;

public enum StateErrorKind
{
    /// <summary>文件不存在 —— 插件没加载，或者 profile 不对。</summary>
    Missing,
    /// <summary>文件在，但 JSON 语法坏了（含空文件）。</summary>
    Parse,
    /// <summary>JSON 语法没问题，但结构与 state.schema.json 对不上。</summary>
    Schema,
    /// <summary>读文件本身失败（被独占、权限不足……）。</summary>
    Io,
}

public sealed record StateReadError(StateErrorKind Kind, string Message);

/// <summary>
/// 状态文件的一次性读取 + 校验 + 反序列化。
///
/// 刻意做成静态纯函数：窗口的轮询线程和 headless 的 <c>--dump-status</c>
/// 走的是**同一段代码**，所以对 dump 输出做的断言真实覆盖了状态栏的判断逻辑。
///
/// 读取用 FileShare.ReadWrite|Delete 打开，避免和插件的「临时文件 + rename」
/// 原子替换抢锁；失败重试 3 次（每次 15ms），因为改名那一瞬间可能读到不存在。
/// </summary>
public static class StateFileReader
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        AllowTrailingCommas = true,          // 手改状态文件调样式时留个逗号不该让面板罢工
        ReadCommentHandling = JsonCommentHandling.Skip,
    };

    public static bool TryRead(string path, out PanelSnapshot? snapshot, out StateReadError? error)
    {
        snapshot = null;
        error = null;

        byte[]? bytes = null;
        string? ioError = null;

        try
        {
            if (!File.Exists(path))
            {
                error = new StateReadError(
                    StateErrorKind.Missing,
                    $"状态文件不存在：{path}（确认 dsh-remote-panel 插件已在当前 profile 启用）");
                return false;
            }

            for (int attempt = 0; attempt < 3 && bytes is null; attempt++)
            {
                try
                {
                    using var stream = new FileStream(
                        path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                    using var buffer = new MemoryStream();
                    stream.CopyTo(buffer);
                    bytes = buffer.ToArray();
                }
                catch (IOException ex)
                {
                    ioError = ex.Message;
                    Thread.Sleep(15);
                }
                catch (UnauthorizedAccessException ex)
                {
                    ioError = ex.Message;
                    Thread.Sleep(15);
                }
            }

            if (bytes is null)
            {
                error = new StateReadError(StateErrorKind.Io, $"状态文件读取失败：{ioError}");
                return false;
            }
        }
        catch (Exception ex)
        {
            error = new StateReadError(StateErrorKind.Io, $"状态文件读取失败：{ex.Message}");
            return false;
        }

        // ---- 语法 ----
        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(bytes, new JsonDocumentOptions
            {
                AllowTrailingCommas = true,
                CommentHandling = JsonCommentHandling.Skip,
            });
        }
        catch (JsonException ex)
        {
            error = new StateReadError(StateErrorKind.Parse, DescribeSyntaxError(ex));
            return false;
        }

        using (document)
        {
            // ---- 结构（带具体字段路径） ----
            string? schemaError = StateValidator.Validate(document.RootElement);
            if (schemaError is not null)
            {
                error = new StateReadError(StateErrorKind.Schema, schemaError);
                return false;
            }

            // ---- 绑定 ----
            try
            {
                snapshot = document.RootElement.Deserialize<PanelSnapshot>(JsonOptions);
            }
            catch (JsonException ex)
            {
                error = new StateReadError(StateErrorKind.Parse, DescribeSyntaxError(ex));
                return false;
            }
        }

        if (snapshot is null)
        {
            error = new StateReadError(StateErrorKind.Schema, "状态文件反序列化后为空（顶层不是对象）");
            return false;
        }

        // schema 里这两个字段是必填数组，但 JSON 显式写 null 时 System.Text.Json
        // 会把属性置成 null（覆盖掉字段初始化器）。这里补回来，后面就再也不用判空。
        snapshot.Targets ??= new List<TargetState>();
        snapshot.Errors ??= new List<TargetErrorEntry>();

        return true;
    }

    /// <summary>
    /// 把 JsonException 摊平成一行，带上行号/字节位置/JSON 路径 ——
    /// 这三样是「文件在哪儿坏了」的全部线索，缺一个都得靠猜。
    /// </summary>
    private static string DescribeSyntaxError(JsonException ex)
    {
        string detail = ex.Message;
        if (ex.LineNumber is long line)
        {
            detail += $"（第 {line + 1} 行";
            if (ex.BytePositionInLine is long col) detail += $"，第 {col + 1} 列";
            detail += "）";
        }
        if (!string.IsNullOrEmpty(ex.Path) && !detail.Contains("Path:", StringComparison.Ordinal))
        {
            detail += $" 路径 {ex.Path}";
        }
        return detail;
    }
}

/// <summary>
/// 轮询状态文件（默认 1s）。
/// 插件以「写临时文件再 rename」的方式原子替换，所以这里永远读不到半截 JSON。
///
/// 这里**不做** 「文件没变就跳过」的优化：1s 一次、几万个字节的解析对本机来说
/// 微不足道，换来的是「状态栏永远反映磁盘上的最新事实」，也少一处状态。
/// 更关键的是失败路径必须每次都上报 —— 否则改坏文件之后状态栏会一直显示旧的成功结果。
/// </summary>
public sealed class WsxStateReader : IDisposable
{
    private readonly string _path;
    private readonly Timer _timer;
    private bool _disposed;

    /// <summary>在后台线程触发；订阅方负责切回 UI 线程。</summary>
    public event Action<PanelSnapshot>? SnapshotRead;

    /// <summary>读取/解析失败时触发，带上具体原因。</summary>
    public event Action<StateReadError>? ReadFailed;

    public WsxStateReader(string path, int intervalMs = 1000)
    {
        _path = path;
        // dueTime=0：立刻读一次，别让窗口空等一个轮询周期。
        _timer = new Timer(_ => Poll(), null, 0, Math.Max(200, intervalMs));
    }

    private void Poll()
    {
        if (_disposed) return;
        try
        {
            if (StateFileReader.TryRead(_path, out var snapshot, out var error))
            {
                if (snapshot is not null) SnapshotRead?.Invoke(snapshot);
            }
            else if (error is not null)
            {
                ReadFailed?.Invoke(error);
            }
        }
        catch (Exception ex)
        {
            try { ReadFailed?.Invoke(new StateReadError(StateErrorKind.Io, ex.Message)); }
            catch { /* 订阅方抛异常不能把轮询线程打死 */ }
        }
    }

    public void Dispose()
    {
        _disposed = true;
        _timer.Dispose();
    }

    /// <summary>
    /// 立刻读一次（标题栏的「重新读取」按钮用）。丢到线程池上，
    /// 绝不在 UI 线程里做文件 IO —— 一次网络盘上的读取能卡住整个窗口。
    /// </summary>
    public void PollNow()
    {
        if (_disposed) return;
        ThreadPool.QueueUserWorkItem(_ =>
        {
            try { Poll(); }
            catch { /* Poll 内部已经兜过异常 */ }
        });
    }
}

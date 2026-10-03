using Windows.UI.ViewManagement;

namespace DshWsxPanel;

/// <summary>
/// 跟随系统明暗。用 UISettings 而不是读注册表：
///   - GetColorValue(UIColorType.Background) 浅色主题下返回白、深色下返回黑；
///   - ColorValuesChanged 是系统主题变化的原生通知，不用轮询注册表。
/// 该事件在后台线程触发，订阅方需要自行切回 UI 线程。
/// </summary>
public static class SystemTheme
{
    public enum Mode { System, Light, Dark }

    private static UISettings? _settings;
    private static readonly object Gate = new();

    public static event Action? SystemThemeChanged;

    private static UISettings Settings
    {
        get
        {
            lock (Gate)
            {
                if (_settings is null)
                {
                    _settings = new UISettings();
                    _settings.ColorValuesChanged += (_, _) =>
                    {
                        try { SystemThemeChanged?.Invoke(); } catch { /* ignore */ }
                    };
                }
                return _settings;
            }
        }
    }

    /// <summary>系统当前是否为浅色。</summary>
    public static bool IsSystemLight()
    {
        try
        {
            var background = Settings.GetColorValue(UIColorType.Background);
            return background.R > 127;
        }
        catch
        {
            return true;
        }
    }

    /// <summary>把「系统 / 浅色 / 深色」解析成实际的浅色布尔值。</summary>
    public static bool ResolveIsLight(Mode mode) => mode switch
    {
        Mode.Light => true,
        Mode.Dark => false,
        _ => IsSystemLight(),
    };

    public static Mode Parse(string? value) => value switch
    {
        "Light" => Mode.Light,
        "Dark" => Mode.Dark,
        _ => Mode.System,
    };
}

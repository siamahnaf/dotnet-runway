using System.Text.Json;
using System.Text.Json.Serialization;

namespace Runway;

/// <summary>A project the user has added, in the order they arranged it.</summary>
public sealed class SavedProject
{
    public string Path { get; set; } = "";
    public string Profile { get; set; } = "https";
    public int Order { get; set; }
}

/// <summary>
/// Everything that must outlive the process: the project list with its manual
/// ordering, and the window's own geometry.
///
/// Window bounds are stored here rather than left to the shell because
/// remembering them is one of the reasons this app exists at all.
/// </summary>
public sealed class AppState
{
    public List<SavedProject> Projects { get; set; } = new();

    public int WindowX { get; set; } = -1;
    public int WindowY { get; set; } = -1;
    public int WindowWidth { get; set; } = 460;
    public int WindowHeight { get; set; } = 560;
    public bool AlwaysOnTop { get; set; }

    [JsonIgnore]
    public static string Dir =>
        Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "Runway");

    [JsonIgnore]
    public static string FilePath => Path.Combine(Dir, "state.json");

    private static readonly JsonSerializerOptions Options = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    public static AppState Load()
    {
        try
        {
            if (File.Exists(FilePath))
            {
                var json = File.ReadAllText(FilePath);
                var loaded = JsonSerializer.Deserialize<AppState>(json, Options);
                if (loaded is not null) return loaded;
            }
        }
        catch
        {
            // A corrupt state file must never stop the app starting; a fresh
            // one costs the user their list, not their work.
        }
        return new AppState();
    }

    public void Save()
    {
        try
        {
            Directory.CreateDirectory(Dir);
            File.WriteAllText(FilePath, JsonSerializer.Serialize(this, Options));
        }
        catch
        {
            // Best effort. Losing the list is not worth crashing over.
        }
    }

    public SavedProject Remember(string path, string profile)
    {
        var existing = Projects.FirstOrDefault(
            p => string.Equals(p.Path, path, StringComparison.OrdinalIgnoreCase));

        if (existing is not null)
        {
            existing.Profile = profile;
            Save();
            return existing;
        }

        var added = new SavedProject
        {
            Path = path,
            Profile = profile,
            Order = Projects.Count == 0 ? 0 : Projects.Max(p => p.Order) + 1,
        };
        Projects.Add(added);
        Save();
        return added;
    }

    public void Forget(string path)
    {
        Projects.RemoveAll(p => string.Equals(p.Path, path, StringComparison.OrdinalIgnoreCase));
        Save();
    }

    public void SetProfile(string path, string profile)
    {
        var found = Projects.FirstOrDefault(
            p => string.Equals(p.Path, path, StringComparison.OrdinalIgnoreCase));
        if (found is null) return;
        found.Profile = profile;
        Save();
    }

    /// <summary>
    /// Apply an explicit ordering, as produced by dragging a card. Paths not
    /// mentioned keep their relative position after the ones that were.
    /// </summary>
    public void Reorder(IReadOnlyList<string> pathsInOrder)
    {
        var rank = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        for (var i = 0; i < pathsInOrder.Count; i++) rank[pathsInOrder[i]] = i;

        var next = pathsInOrder.Count;
        foreach (var p in Projects)
        {
            p.Order = rank.TryGetValue(p.Path, out var r) ? r : next++;
        }
        Save();
    }

    public IEnumerable<SavedProject> Ordered() => Projects.OrderBy(p => p.Order);
}

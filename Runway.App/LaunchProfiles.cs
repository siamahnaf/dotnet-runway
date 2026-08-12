using System.Text.Json;

namespace Runway;

/// <summary>
/// Reads Properties/launchSettings.json next to a .csproj.
/// </summary>
public static class LaunchProfiles
{
    /// <summary>
    /// Profile names that `dotnet run --launch-profile` can actually drive.
    /// IIS Express and friends are excluded: they are not project commands.
    /// Returns an empty list when the file is missing or unreadable, which the
    /// caller treats as "fall back to http/https".
    /// </summary>
    public static List<string> Read(string csprojPath)
    {
        var names = new List<string>();
        try
        {
            var dir = Path.GetDirectoryName(csprojPath);
            if (dir is null) return names;

            var settings = Path.Combine(dir, "Properties", "launchSettings.json");
            if (!File.Exists(settings)) return names;

            using var doc = JsonDocument.Parse(File.ReadAllText(settings));
            if (!doc.RootElement.TryGetProperty("profiles", out var profiles)) return names;

            foreach (var profile in profiles.EnumerateObject())
            {
                var isProjectCommand =
                    !profile.Value.TryGetProperty("commandName", out var cmd) ||
                    string.Equals(cmd.GetString(), "Project", StringComparison.OrdinalIgnoreCase);

                if (isProjectCommand) names.Add(profile.Name);
            }
        }
        catch
        {
            // Malformed launchSettings is the project's problem, not ours.
        }
        return names;
    }

    /// <summary>
    /// Project name for display. The shared product prefix is pure noise in a
    /// narrow list, so it is trimmed when it would not empty the name.
    /// </summary>
    public static string DisplayName(string csprojPath, string prefix = "Propsys.")
    {
        var name = Path.GetFileNameWithoutExtension(csprojPath);
        if (!string.IsNullOrEmpty(prefix) &&
            name.StartsWith(prefix, StringComparison.Ordinal) &&
            name.Length > prefix.Length)
        {
            return name[prefix.Length..];
        }
        return name;
    }
}

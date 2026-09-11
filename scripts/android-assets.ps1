function ConvertTo-AndroidAssetEntryName([string]$EntryName) {
    $normalized = $EntryName.Replace('\', '/')
    if (!$normalized.StartsWith('assets/', [StringComparison]::Ordinal)) {
        throw "Not an aapt asset entry: $EntryName"
    }
    return 'assets/public/' + $normalized.Substring(7)
}

function Assert-AndroidAssetArchive([string]$ArchivePath, [string]$PublicDirectory) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $root = (Resolve-Path -LiteralPath $PublicDirectory).Path
    $archive = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $ArchivePath).Path)
    try {
        $names = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        foreach ($entry in $archive.Entries) {
            # Windows extraction accepts backslashes; Android AssetManager does not.
            if ($entry.FullName.Contains('\')) { throw "Android ZIP entry contains a backslash: $($entry.FullName)" }
            if (!$names.Add($entry.FullName)) { throw "Duplicate ZIP entry: $($entry.FullName)" }
        }
        foreach ($file in Get-ChildItem -LiteralPath $root -Recurse -File) {
            $relative = $file.FullName.Substring($root.Length + 1).Replace('\', '/')
            $name = 'assets/public/' + $relative
            if (!$names.Contains($name)) { throw "Missing exact Android asset path: $name" }
            $stream = $archive.GetEntry($name).Open()
            $source = $file.OpenRead()
            $sha = [System.Security.Cryptography.SHA256]::Create()
            try {
                $actual = [Convert]::ToBase64String($sha.ComputeHash($stream))
                $expected = [Convert]::ToBase64String($sha.ComputeHash($source))
            } finally { $sha.Dispose(); $stream.Dispose(); $source.Dispose() }
            if ($actual -ne $expected) {
                throw "Android asset content mismatch: $name"
            }
        }
    } finally { $archive.Dispose() }
}

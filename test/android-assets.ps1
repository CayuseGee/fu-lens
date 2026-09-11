param([string]$ScratchDirectory)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\scripts\android-assets.ps1')
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression

$inputName = 'assets/vendor\ort-1.17.3\ort.wasm.min.js'
$expected = 'assets/public/vendor/ort-1.17.3/ort.wasm.min.js'
if ((ConvertTo-AndroidAssetEntryName $inputName) -cne $expected) { throw 'Backslash normalization failed' }
if ((ConvertTo-AndroidAssetEntryName 'assets/vendor/ort-1.17.3/ort.wasm.min.js') -cne $expected) { throw 'POSIX normalization failed' }

$root = Join-Path $ScratchDirectory 'public'
foreach ($mode in @('valid', 'backslash', 'missing', 'corrupt', 'duplicate', 'wrong-case')) {
    $path = Join-Path $ScratchDirectory ($mode + '.zip')
    $archive = [System.IO.Compression.ZipFile]::Open($path, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($file in Get-ChildItem -LiteralPath $root -Recurse -File) {
            $relative = $file.FullName.Substring($root.Length + 1)
            if ($mode -eq 'missing' -and $relative.EndsWith('.onnx')) { continue }
            $name = ConvertTo-AndroidAssetEntryName ('assets/' + $relative)
            if ($mode -eq 'backslash') { $name = 'assets/public/' + $relative.Replace('/', '\') }
            if ($mode -eq 'wrong-case') { $name = $name.Replace('vendor/', 'Vendor/') }
            $source = if ($mode -eq 'corrupt') { Join-Path $root 'index.html' } else { $file.FullName }
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $source, $name) | Out-Null
            if ($mode -eq 'duplicate') {
                [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $source, $name) | Out-Null
            }
        }
    } finally { $archive.Dispose() }
    $failed = $false
    try { Assert-AndroidAssetArchive $path $root } catch {
        if ($mode -eq 'valid') { throw }
        $failed = $true
    }
    if (($mode -eq 'valid') -eq $failed) { throw "Unexpected validation result for $mode" }
}
Write-Output 'Android raw ZIP path and content regression checks passed.'

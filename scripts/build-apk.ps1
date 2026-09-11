param(
    [string]$SdkDirectory = $env:ANDROID_HOME,
    [string]$JavaDirectory = $env:JAVA_HOME,
    [string]$SigningDirectory,
    [switch]$DebugBuild
)
$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot 'android-assets.ps1')
if (!$JavaDirectory) { $JavaDirectory = 'C:\Program Files\Java\jdk-21' }
if (!$SdkDirectory) { throw 'Pass -SdkDirectory with an installed Android SDK (platform 36, build-tools 36.0.0).' }
$buildTools = Join-Path $SdkDirectory 'build-tools\36.0.0'
$androidJar = Join-Path $SdkDirectory 'platforms\android-36\android.jar'
foreach ($required in @($androidJar, "$buildTools\aapt2.exe", "$buildTools\lib\d8.jar", "$JavaDirectory\bin\javac.exe")) {
    if (!(Test-Path -LiteralPath $required)) { throw "Missing build tool: $required" }
}
$buildDirectory = Join-Path $projectDirectory ('android\build\' + [Guid]::NewGuid().ToString('N'))
$artifacts = Join-Path $projectDirectory 'artifacts'
if (!$SigningDirectory) { $SigningDirectory = Join-Path $projectDirectory '.android-signing' }
$signingDirectory = $SigningDirectory
$classesDirectory = Join-Path $buildDirectory 'classes'
$dexDirectory = Join-Path $buildDirectory 'dex'
$resourcesDirectory = Join-Path $buildDirectory 'res'
foreach ($directory in @($buildDirectory, $classesDirectory, $dexDirectory, $resourcesDirectory, $artifacts, $signingDirectory)) {
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
}
Copy-Item -Path "$projectDirectory\android\res\*" -Destination $resourcesDirectory -Recurse
$drawable = Join-Path $resourcesDirectory 'drawable'
New-Item -ItemType Directory -Path $drawable | Out-Null

# Keep the handoff project's existing app icon and offline runtime unchanged.
Copy-Item -LiteralPath "$projectDirectory\public\icon-192.png" -Destination (Join-Path $drawable 'ic_launcher.png')
foreach ($asset in @('vendor/ort.min.js', 'vendor/ort-wasm-simd-threaded.wasm', 'vendor/ort-wasm-simd-threaded.mjs',
    'vendor/ort-wasm-simd-threaded.jsep.wasm', 'vendor/ort-wasm-simd-threaded.jsep.mjs', 'models/nano/mahjong-yolon-best.onnx')) {
    if (!(Test-Path -LiteralPath (Join-Path "$projectDirectory\public" $asset))) { throw "Missing offline asset: $asset" }
}
foreach ($asset in @('ort.wasm.min.js', 'ort-wasm-simd.wasm', 'ort-wasm.wasm', 'LICENSE')) {
    if (!(Test-Path -LiteralPath (Join-Path "$projectDirectory\public\vendor\ort-1.17.3" $asset))) { throw "Missing Android compatibility runtime: $asset" }
}

$compiled = Join-Path $buildDirectory 'resources.zip'
$unsigned = Join-Path $buildDirectory 'unsigned.apk'
$aligned = Join-Path $buildDirectory 'aligned.apk'
$manifest = [xml][System.IO.File]::ReadAllText((Join-Path $projectDirectory 'android\AndroidManifest.xml'))
$androidNamespace = 'http://schemas.android.com/apk/res/android'
$versionName = $manifest.manifest.GetAttribute('versionName', $androidNamespace)
$versionCode = $manifest.manifest.GetAttribute('versionCode', $androidNamespace)
$suffix = if ($DebugBuild) { '-debug' } else { '' }
$release = Join-Path $artifacts "FuLens-$versionName-r$versionCode$suffix.apk"
if (Test-Path -LiteralPath $release) { throw "Refusing to overwrite an existing artifact: $release" }
$manifest.manifest.application.SetAttribute('debuggable', $androidNamespace, $DebugBuild.IsPresent.ToString().ToLowerInvariant()) | Out-Null
if ($DebugBuild) {
    $manifest.manifest.SetAttribute('package', 'com.fulens.app.debug')
    $manifest.manifest.application.SetAttribute('label', $androidNamespace, 'FuLens (debug)') | Out-Null
    $manifest.manifest.application.provider.SetAttribute('authorities', $androidNamespace, 'com.fulens.app.debug.capture') | Out-Null
}
$buildManifest = Join-Path $buildDirectory 'AndroidManifest.xml'
$manifest.Save($buildManifest)
& "$buildTools\aapt2.exe" compile --dir $resourcesDirectory -o $compiled
if ($LASTEXITCODE) { throw 'Resource compilation failed.' }
& "$buildTools\aapt2.exe" link -o $unsigned -I $androidJar --manifest $buildManifest $compiled -A "$projectDirectory\public" --auto-add-overlay
if ($LASTEXITCODE) { throw 'Resource linking failed.' }
$sources = @(Get-ChildItem -LiteralPath "$projectDirectory\android\src" -Recurse -Filter '*.java' | ForEach-Object { $_.FullName })
& "$JavaDirectory\bin\javac.exe" -encoding UTF-8 -source 8 -target 8 -Xlint:-options -classpath $androidJar -d $classesDirectory @sources
if ($LASTEXITCODE) { throw 'Java compilation failed.' }
$classJar = Join-Path $buildDirectory 'classes.jar'
& "$JavaDirectory\bin\jar.exe" cf $classJar -C $classesDirectory .
if ($LASTEXITCODE) { throw 'Class archive creation failed.' }
& "$JavaDirectory\bin\java.exe" -cp "$buildTools\lib\d8.jar" com.android.tools.r8.D8 --lib $androidJar --min-api 26 --output $dexDirectory $classJar
if ($LASTEXITCODE) { throw 'DEX compilation failed.' }

# aapt stores the web root as assets/*; the native loader reads assets/public/*.
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open($unsigned, [System.IO.Compression.ZipArchiveMode]::Update)
try {
    foreach ($entry in @($zip.Entries | Where-Object { $_.FullName.StartsWith('assets/') })) {
        $name = ConvertTo-AndroidAssetEntryName $entry.FullName
        $replacement = $zip.CreateEntry($name)
        $source = $entry.Open()
        $destination = $replacement.Open()
        try { $source.CopyTo($destination) } finally { $destination.Dispose(); $source.Dispose() }
        $entry.Delete()
    }
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Join-Path $dexDirectory 'classes.dex'), 'classes.dex') | Out-Null
} finally { $zip.Dispose() }
Assert-AndroidAssetArchive $unsigned (Join-Path $projectDirectory 'public')
& "$buildTools\zipalign.exe" -f -p 4 $unsigned $aligned
if ($LASTEXITCODE) { throw 'APK alignment failed.' }

$keyFile = Join-Path $signingDirectory 'release.p12'
$passwordFile = Join-Path $signingDirectory 'password.txt'
try {
    if (!(Test-Path -LiteralPath $keyFile)) {
        $randomBytes = New-Object byte[] 32
        $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        $random.GetBytes($randomBytes)
        $random.Dispose()
        $env:FULENS_SIGN_PASSWORD = [Convert]::ToBase64String($randomBytes)
        [System.IO.File]::WriteAllText($passwordFile, $env:FULENS_SIGN_PASSWORD)
        & "$JavaDirectory\bin\keytool.exe" -genkeypair -keystore $keyFile -storetype PKCS12 -alias fulens -keyalg RSA -keysize 2048 -validity 10000 -storepass:env FULENS_SIGN_PASSWORD -keypass:env FULENS_SIGN_PASSWORD -dname 'CN=FuLens' -noprompt
        if ($LASTEXITCODE) { throw 'Signing key generation failed.' }
    } else {
        $env:FULENS_SIGN_PASSWORD = [System.IO.File]::ReadAllText($passwordFile).Trim()
    }
    & "$JavaDirectory\bin\java.exe" -jar "$buildTools\lib\apksigner.jar" sign --ks $keyFile --ks-key-alias fulens --ks-pass env:FULENS_SIGN_PASSWORD --key-pass env:FULENS_SIGN_PASSWORD --out $release $aligned
    if ($LASTEXITCODE) { throw 'APK signing failed.' }
    & "$JavaDirectory\bin\java.exe" -jar "$buildTools\lib\apksigner.jar" verify --verbose --print-certs $release
    if ($LASTEXITCODE) { throw 'APK signature verification failed.' }
    Assert-AndroidAssetArchive $release (Join-Path $projectDirectory 'public')
    & "$buildTools\zipalign.exe" -c -p 4 $release
    if ($LASTEXITCODE) { throw 'Signed APK alignment check failed.' }
    & "$buildTools\aapt.exe" dump badging $release
    if ($LASTEXITCODE) { throw 'APK manifest validation failed.' }
    $permissions = & "$buildTools\aapt.exe" dump permissions $release
    if ($permissions -match 'android.permission.INTERNET') { throw 'Offline APK must not request Internet access.' }
    Get-FileHash -LiteralPath $release -Algorithm SHA256
    Write-Output "APK: $release"
} finally { Remove-Item Env:FULENS_SIGN_PASSWORD -ErrorAction SilentlyContinue }

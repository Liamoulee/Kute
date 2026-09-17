# Bumps the client version in Cargo.toml, Cargo.lock, package.json and resources/installer_script.wxs.
# Prints the resulting version. "none" changes nothing and prints the current one.
param(
    [ValidateSet("patch", "minor", "major", "none")]
    [string]$Bump = "patch",
    [string]$Root = (Get-Location).Path
)

$ErrorActionPreference = "Stop"
$utf8 = [Text.UTF8Encoding]::new($false)

function Update-File([string]$RelativePath, [string]$Pattern, [string]$NewVersion) {
    $path = Join-Path $Root $RelativePath
    $text = [IO.File]::ReadAllText($path)
    $regex = [regex]::new($Pattern)
    if (-not $regex.IsMatch($text)) {
        throw "No version found in $RelativePath"
    }
    # only the first match, and the file keeps its line endings
    $text = $regex.Replace($text, ('${1}' + $NewVersion + '${2}'), 1)
    [IO.File]::WriteAllText($path, $text, $utf8)
}

$cargo = [IO.File]::ReadAllText((Join-Path $Root "Cargo.toml"))
$match = [regex]::Match($cargo, '(?m)^version\s*=\s*"(\d+)\.(\d+)\.(\d+)"')
if (-not $match.Success) {
    throw "Could not find a plain x.y.z package version in Cargo.toml"
}

$major = [int]$match.Groups[1].Value
$minor = [int]$match.Groups[2].Value
$patch = [int]$match.Groups[3].Value

switch ($Bump) {
    "major" { $major++; $minor = 0; $patch = 0 }
    "minor" { $minor++; $patch = 0 }
    "patch" { $patch++ }
}
$version = "$major.$minor.$patch"

if ($Bump -ne "none") {
    Update-File "Cargo.toml" '(?m)(^version\s*=\s*")[^"]+(")' $version
    Update-File "Cargo.lock" '(?m)(^name = "kute"\r?\nversion = ")[^"]+(")' $version
    Update-File "package.json" '(?m)(^\s*"version":\s*")[^"]+(")' $version
    Update-File "resources/installer_script.wxs" '(<Package\b[^>]*\bVersion=")[^"]+(")' $version
}

Write-Output $version

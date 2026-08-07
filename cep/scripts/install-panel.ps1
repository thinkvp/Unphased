# Installs the Unphased CEP panel for the current user (no admin needed):
#  1. junctions cep/ into the user CEP extensions folder (edits stay live)
#  2. enables PlayerDebugMode so the unsigned panel loads (CSXS 10/11/12)
# Restart Premiere Pro afterwards.
#
# The junction target is cep/ itself, so realpath() from inside the panel
# resolves back to the repo and jobRunner.js finds ../engine/cli.js next to it.

$ErrorActionPreference = 'Stop'

$repoPanel = Resolve-Path (Join-Path $PSScriptRoot '..')
$extDir = Join-Path $env:APPDATA 'Adobe\CEP\extensions'
$dest = Join-Path $extDir 'com.unphased.panel'

New-Item -ItemType Directory -Force $extDir | Out-Null

if (Test-Path $dest) {
    $item = Get-Item $dest -Force
    if ($item.LinkType -eq 'Junction') {
        if ($item.Target -eq "$repoPanel") {
            Write-Host "Junction already in place: $dest -> $repoPanel"
        } else {
            [IO.Directory]::Delete($dest)
            New-Item -ItemType Junction -Path $dest -Target $repoPanel | Out-Null
            Write-Host "Junction updated: $dest -> $repoPanel"
        }
    } else {
        throw "$dest exists and is not a junction - remove it manually first."
    }
} else {
    New-Item -ItemType Junction -Path $dest -Target $repoPanel | Out-Null
    Write-Host "Junction created: $dest -> $repoPanel"
}

foreach ($v in 10, 11, 12) {
    $key = "HKCU:\Software\Adobe\CSXS.$v"
    New-Item -Path $key -Force | Out-Null
    Set-ItemProperty -Path $key -Name PlayerDebugMode -Value '1' -Type String
    Write-Host "PlayerDebugMode=1 set in CSXS.$v"
}

Write-Host "`nDone. Restart Premiere Pro, then open Window > Extensions > Unphased."

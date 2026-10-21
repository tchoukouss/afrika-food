# Sauvegarde PostgreSQL d'AFRIKA FOOD (format custom, compressé).
# Usage :  powershell -File scripts\backup.ps1
# Planification : Planificateur de tâches Windows, tous les jours à 23h30 par exemple.
# Conserve les $KeepDays derniers jours de sauvegardes.

param(
  [string]$EnvFile = "$PSScriptRoot\..\apps\api\.env",
  [string]$BackupDir = "$PSScriptRoot\..\backups",
  [int]$KeepDays = 30,
  [string]$PgBin = "C:\Program Files\PostgreSQL\18\bin"
)

$ErrorActionPreference = 'Stop'

$line = Get-Content $EnvFile | Where-Object { $_ -match '^DATABASE_URL=' } | Select-Object -First 1
if (-not $line) { throw "DATABASE_URL introuvable dans $EnvFile" }
$uri = [System.Uri]($line -replace '^DATABASE_URL=', '' -replace '\?.*$', '')
$user, $pass = $uri.UserInfo.Split(':', 2)
$db = $uri.AbsolutePath.TrimStart('/')

New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
$stamp = Get-Date -Format 'yyyy-MM-dd_HHmm'
$file = Join-Path $BackupDir "afrika_food_$stamp.dump"

$env:PGPASSWORD = [System.Uri]::UnescapeDataString($pass)
try {
  & "$PgBin\pg_dump.exe" -h $uri.Host -p $uri.Port -U $user -d $db -F c -Z 6 -f $file
  if ($LASTEXITCODE -ne 0) { throw "pg_dump a échoué (code $LASTEXITCODE)" }
  # Vérifie que l'archive est lisible.
  & "$PgBin\pg_restore.exe" -l $file | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Archive illisible : $file" }
} finally {
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
}

Get-ChildItem $BackupDir -Filter 'afrika_food_*.dump' |
  Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$KeepDays) } |
  Remove-Item -Confirm:$false

Write-Output "Sauvegarde OK : $file ($([math]::Round((Get-Item $file).Length / 1KB)) Ko)"

# Removes the Eloshon Scraper native messaging host registration from Chrome, Edge
# and Brave (HKCU only). Safe to run even if some keys are absent.
$ErrorActionPreference = 'Stop'
$name = 'com.eloshon.scraper.host'
$bases = @(
  'HKCU:\Software\Google\Chrome\NativeMessagingHosts',
  'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts',
  'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts'
)
foreach ($base in $bases) {
  $key = Join-Path $base $name
  if (Test-Path $key) { Remove-Item -Path $key -Recurse -Force; Write-Host "supprime $key" }
  else { Write-Host "absent   $key" }
}

' 激活 osu! 窗口并发送按键（用于自动化验证：进入选歌 / 制谱器）
' 用法: cscript //nologo sendkey.vbs "p"
Option Explicit
Dim sh, keys
Set sh = CreateObject("WScript.Shell")
If WScript.Arguments.Count > 0 Then
  keys = WScript.Arguments(0)
Else
  keys = "p"
End If
WScript.Sleep 500
sh.AppActivate "osu!"
WScript.Sleep 1200
sh.SendKeys keys
WScript.Sleep 500
WScript.Echo "sent: " & keys

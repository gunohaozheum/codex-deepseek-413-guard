Option Explicit

Dim fso, shell, root, proxy, nodePath, command
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

root = fso.GetParentFolderName(WScript.ScriptFullName)
proxy = fso.BuildPath(root, "src\proxy.mjs")

If WScript.Arguments.Count >= 1 Then
  nodePath = WScript.Arguments(0)
Else
  nodePath = shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
  If Not fso.FileExists(nodePath) Then
    nodePath = "node.exe"
  End If
End If

shell.CurrentDirectory = root
command = Chr(34) & nodePath & Chr(34) & " " & Chr(34) & proxy & Chr(34)
shell.Run command, 0, False

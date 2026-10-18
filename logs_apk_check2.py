import sys, zipfile
sys.stdout.reconfigure(encoding="utf-8")
p = r"C:\ziisan-app\out\ziisan-android.apk"
with zipfile.ZipFile(p) as z:
    for n in ("classes.dex", "classes2.dex"):
        b = z.read(n)
        magic = b[:8]
        print(f"  {n}：{len(b)} 字节｜magic={magic!r}｜含 MainActivity: {b'MainActivity' in b}")
        print(f"     含包名 io/github/mist1494732214: {b'io/github/mist1494732214' in b}")
        print(f"     含 start URL 片段 mist1494732214.github.io: {b'mist1494732214.github.io' in b}")
    m = z.read("AndroidManifest.xml")
    print(f"\n  AndroidManifest.xml（二进制）：{len(m)} 字节｜含 launcher intent 标记:", b"android.intent.category.LAUNCHER" in m or b"LAUNCHER" in m)
    print("  含 INTERNET 权限字符串:", b"android.permission.INTERNET" in m)
    print("  含 WebView 相关:", b"WebView" in m or b"webview" in m)
    r = z.read("resources.arsc")
    print(f"  resources.arsc：{len(r)} 字节")

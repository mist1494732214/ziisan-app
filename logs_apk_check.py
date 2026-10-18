import sys, urllib.request, zipfile, os
sys.stdout.reconfigure(encoding="utf-8")
url = "https://github.com/mist1494732214/ziisan-app/releases/latest/download/ziisan-android.apk"
dst = r"C:\ziisan-app\out\ziisan-android.apk"
try:
    urllib.request.urlretrieve(url, dst)
    size = os.path.getsize(dst)
    print(f"  下载成功：{size} 字节（{size/1024:.1f} KB）")
    with zipfile.ZipFile(dst) as z:
        names = z.namelist()
        print(f"  内含 {len(names)} 个条目：")
        for n in sorted(names)[:12]:
            print("    " + n)
        dex = [n for n in names if n.endswith('.dex')]
        if dex:
            blob = z.read(dex[0])
            print(f"  {dex[0]}：{len(blob)} 字节｜包含 MainActivity：", b"MainActivity" in blob)
            print("  包含 START URL 常量：", b"mist1494732214.github.io" in blob)
except Exception as e:
    print("  ✗", type(e).__name__, e)

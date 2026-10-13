import re
p = r"D:\DeepSeek Harness\resources\app.asar"
data = open(p, "rb").read()
for pat in [b"scroll-behavior", b"behavior:\"smooth\"", b"behavior: \"smooth\""]:
    idx = [m.start() for m in re.finditer(re.escape(pat), data)]
    print("=== ", pat.decode(), len(idx), "hits")
    for i in idx[:8]:
        seg = data[max(0,i-160): i+160].decode("latin1").replace("\n", " ")
        print("---", seg)

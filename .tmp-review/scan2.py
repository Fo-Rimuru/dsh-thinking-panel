import re
p = r"D:\DeepSeek Harness\resources\app.asar"
data = open(p, "rb").read()
for pat, before, after in [(b"useScrollFollow", 700, 2200), (b"reading.followingTail", 1200, 800)]:
    idx = [m.start() for m in re.finditer(re.escape(pat), data)]
    print("########", pat.decode(), len(idx), "hits")
    for i in idx[:2]:
        seg = data[max(0,i-before): i+after].decode("latin1")
        print("========== offset", i)
        print(seg)

"""End-to-end check of the edge <-> cloud loop against two running devices.

    python scripts/e2e_test.py            # devices on :8101 and :8102, Qdrant on :6333

Exercises: local ingest, hybrid search, privacy boundary (ledger + server),
push/pull, evolving memory detection, concurrent-edit conflict (LWW), and an
offline answer.
"""
import json
import sys
import time

import httpx

A = httpx.Client(base_url="http://127.0.0.1:8101", timeout=180)
B = httpx.Client(base_url="http://127.0.0.1:8102", timeout=180)
failures = 0


def check(label, cond, detail=""):
    global failures
    print(("  PASS " if cond else "  FAIL ") + label + (f"  [{detail}]" if detail and not cond else ""))
    failures += 0 if cond else 1


def add(c, text, sensitivity):
    r = c.post("/api/memories", json={"text": text, "sensitivity": sensitivity})
    r.raise_for_status()
    return r.json()


def ask(c, q):
    out = {"answer": ""}
    with c.stream("POST", "/api/ask", json={"q": q}) as r:
        for line in r.iter_lines():
            if not line:
                continue
            m = json.loads(line)
            if m["type"] == "retrieval":
                out.update(route=m["route"], reason=m["reason"], used=m["used"], hits=m["hits"])
            elif m["type"] == "token":
                out["answer"] += m["t"]
            elif m["type"] == "reroute":
                out.update(route=m["route"], reason=m["reason"])
    return out


print("1. local ingest")
for c in (A, B):
    c.post("/api/network", json={"mode": "auto"})
priv = add(A, f"The compressor torque spec for unit 7 is 45 Nm. (run {time.time():.0f})", "private")["memory"]
shared = add(A, f"Warehouse zone B wifi drops near the metal shelving after 3pm. (run {time.time():.0f})", "shareable")["memory"]
check("private stored with synced=false", priv["sensitivity"] == "private" and not priv["synced"])

print("2. hybrid search works locally")
hits = A.post("/api/search", json={"q": "torque for compressor"}).json()["hits"]
check("top hit is a torque note", hits and "torque spec for unit 7" in hits[0]["text"], hits[:1])

print("3. sync A -> cloud -> B")
ra = A.post("/api/sync").json()
check("A pushed >=1", ra.get("pushed", 0) >= 1, ra)
rb = B.post("/api/sync").json()
b_ids = {m["mem_id"] for m in B.get("/api/memories").json()}
check("B received shared note", shared["mem_id"] in b_ids, rb)
check("B did NOT receive private note", priv["mem_id"] not in b_ids)
again = A.post("/api/sync").json()
check("second sync is a no-op", again.get("pushed") == 0 and again.get("conflicts") == 0, again)
check("nothing left queued on A", A.get("/api/state").json()["memory"]["pending"] == 0)

print("4. privacy audit")
audit = A.get("/api/privacy/audit").json()
check("audit ok (ledger + server)", audit["ok"] and audit["cloud_checked"], audit)

print("5. evolving memory")
upd = add(A, "The compressor torque spec for unit 7 is now 50 Nm after the retrofit.", "private")
check("new note flags the old one as related", any(r["mem_id"] == priv["mem_id"] for r in upd["related"]),
      [(r["mem_id"], r["semantic"]) for r in upd["related"]])
A.post(f"/api/memories/{upd['memory']['mem_id']}/supersede/{priv['mem_id']}")

print("6. concurrent edit -> conflict")
A.post("/api/network", json={"mode": "offline"})
A.patch(f"/api/memories/{shared['mem_id']}", json={"text": "Zone B wifi drops after 3pm — edited on A (offline)."})
time.sleep(0.05)
B.patch(f"/api/memories/{shared['mem_id']}", json={"text": "Zone B wifi fixed with a new access point — edited on B."})
B.post("/api/sync")
A.post("/api/network", json={"mode": "auto"})
time.sleep(1.5)  # reconnect triggers an automatic sync
A.post("/api/sync")
conflicts = A.get("/api/conflicts").json()
c = next((c for c in conflicts if c["mem_id"] == shared["mem_id"]), None)
check("conflict recorded on A", c is not None)
if c:
    check("LWW kept the later write (B)", c["winner"] == "remote" and c["remote"]["by"] == "device_b", c)
a_text = next(m["text"] for m in A.get("/api/memories").json() if m["mem_id"] == shared["mem_id"])
check("A converged to B's text", "edited on B" in a_text, a_text)

print("7. offline answer from local memory")
A.post("/api/network", json={"mode": "offline"})
res = ask(A, "What is the compressor torque spec for unit 7?")
check("routed on-device while offline", res["route"] in ("local", "retrieval"), res.get("reason"))
check("used the newer note, not the superseded one",
      upd["memory"]["mem_id"] in res["used"] and priv["mem_id"] not in res["used"], res["used"])
print("     answer:", res["answer"][:200].replace("\n", " "))
A.post("/api/network", json={"mode": "auto"})

print("8. private context online stays on device")
time.sleep(1)
res = ask(A, "What is the compressor torque spec for unit 7?")
check("no private memory sent to cloud LLM", res["route"] != "cloud" or not any(
    h["sensitivity"] == "private" and h["mem_id"] in res["used"] for h in res["hits"]), res.get("reason"))
check("audit still ok", A.get("/api/privacy/audit").json()["ok"])

print("9. re-tag private -> tombstone -> removed on the other device")
note = add(A, f"Temporary gate code for the east dock is 2291. (run {time.time():.0f})", "shareable")["memory"]
A.post("/api/sync")
B.post("/api/sync")
check("B has the shared note", any(m["mem_id"] == note["mem_id"] for m in B.get("/api/memories").json()))
A.patch(f"/api/memories/{note['mem_id']}", json={"sensitivity": "private"})
r = A.post("/api/sync").json()
check("A retracted it", r.get("retracted") == 1, r)
B.post("/api/sync")
check("B dropped its copy", not any(m["mem_id"] == note["mem_id"] for m in B.get("/api/memories").json()))
audit = A.get("/api/privacy/audit").json()
check("audit ok: tombstone holds no private content", audit["ok"] and not audit["private_in_cloud"], audit)

print("10. server reset -> devices re-upload, nothing deleted locally")
before_a = {m["mem_id"] for m in A.get("/api/memories").json()}
before_b = {m["mem_id"] for m in B.get("/api/memories").json()}
httpx.delete("http://127.0.0.1:6333/collections/edgemind_shared")
ra, rb = A.post("/api/sync").json(), B.post("/api/sync").json()
check("devices noticed and re-queued", ra.get("requeued", 0) + rb.get("requeued", 0) > 0, (ra, rb))
check("nothing removed locally", ra.get("removed") == 0 and rb.get("removed") == 0, (ra, rb))
A.post("/api/sync"); B.post("/api/sync")
check("A kept all memories", before_a <= {m["mem_id"] for m in A.get("/api/memories").json()})
check("B kept all memories", before_b <= {m["mem_id"] for m in B.get("/api/memories").json()})
check("nothing left queued", A.get("/api/state").json()["memory"]["pending"] == 0
      and B.get("/api/state").json()["memory"]["pending"] == 0)

print(f"\n{'ALL PASSED' if not failures else f'{failures} FAILED'}")
sys.exit(1 if failures else 0)

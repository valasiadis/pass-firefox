// Run: gjs -m tests/match_test.js   (from the repo root)
import GLib from "gi://GLib";
import System from "system";
const src = new TextDecoder().decode(GLib.file_get_contents("extension/lib/match.js")[1]);
(0, eval)(src);
const M = globalThis.PassMatch;
let failed = 0;
const eq = (name, a, b) => {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (!ok) failed++;
  print(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`}`);
};

const store = [
  "Acme/erp.acme.de", "Acme/app.dev.widgets-cloud.com", "Private/Commerce/Amazon",
  "Club/host42.example.net:8443/club-admin",
  "Government/Portal/jane@example.org", "Private/Delivery/DHL",
  "Work/example.com/alice", "Work/example.com/bob", "Work/login.example.com",
  "Private/amazon.co.uk",
];
const ctx = (host, extra) => Object.assign(
  { host: M.normalizeHost(host), port: "", site: M.siteOf(host), label: M.siteLabel(host), formKey: host + "/login|login|user,pass" },
  extra || {});

eq("siteOf", [M.siteOf("www.login.example.co.uk"), M.siteOf("a.b.acme.de"), M.siteOf("10.0.0.1")],
   ["example.co.uk", "acme.de", "10.0.0.1"]);
eq("exact host", M.domainMatch("Acme/erp.acme.de", "erp.acme.de").tier, 3);
eq("parent domain", M.domainMatch("Work/example.com/alice", "login.example.com"), { tier: 2, index: 1 });
eq("same site", M.domainMatch("Work/login.example.com", "shop.example.com").tier, 1);
eq("port", M.domainMatch("K/host42.example.net:8443/club-admin", "host42.example.net", "8443").tier, 3);
eq("suffix is no parent", M.domainMatch("Private/amazon.co.uk", "foo.co.uk").tier, 0);
eq("brand name not a domain", M.domainMatch("Private/Commerce/Amazon", "www.amazon.de").tier, 0);

let r = M.rank(store, ctx("erp.acme.de"), "", {});
eq("unique exact -> autofill", M.uniqueMatch(r) && M.uniqueMatch(r).path, "Acme/erp.acme.de");
r = M.rank(store, ctx("example.com"), "", {});
eq("two accounts -> picker", M.uniqueMatch(r), null);
eq("both accounts on top", r.slice(0, 2).map((x) => x.path).sort(), ["Work/example.com/alice", "Work/example.com/bob"]);
r = M.rank(store, ctx("login.example.com"), "", {});
eq("exact beats parent", M.uniqueMatch(r).path, "Work/login.example.com");

r = M.rank(store, ctx("www.amazon.de"), "", {});
eq("brand: no autofill", M.uniqueMatch(r), null);
eq("brand label on top", r.slice(0, 2).map((x) => x.path).sort(), ["Private/Commerce/Amazon", "Private/amazon.co.uk"]);

// History: bob used on this form twice -> on top, and blocks autofill of a different entry.
let h = {};
const c = ctx("example.com");
h = M.recordUse(h, c, "Work/example.com/bob", Date.now() - 1000);
h = M.recordUse(h, c, "Work/example.com/bob");
r = M.rank(store, c, "", h);
eq("remembered first", r[0].path, "Work/example.com/bob");
eq("uses counted", Math.round(r[0].uses.form), 2);
r = M.rank(store, c, "ex", h);
eq("remembered first with query", r[0].path, "Work/example.com/bob");
h = M.recordUse({}, ctx("login.example.com"), "Work/example.com/alice");
r = M.rank(store, ctx("login.example.com"), "", h);
eq("history overrides unique autofill", M.uniqueMatch(r), null);
eq("history entry above exact host", r[0].path, "Work/example.com/alice");
// Other form on the same host still benefits from host scope.
r = M.rank(store, ctx("login.example.com", { formKey: "other" }), "", h);
eq("host scope", r[0].path, "Work/example.com/alice");

eq("fuzzy miss", M.fuzzyMatch("xyz", "Private/DHL"), null);
const a = M.fuzzyMatch("dhl", "Private/Delivery/DHL"), b = M.fuzzyMatch("dhl", "Private/Delivery/dhlx-old");
eq("fuzzy prefers whole word", a.score > b.score, true);
eq("multi-token", !!M.fuzzyMatch("acm erp", "Acme/erp.acme.de"), true);
eq("fuzzy separator bonus", M.fuzzyMatch("pca", "Private/Commerce/Amazon").score > M.fuzzyMatch("pca", "xpxcxa").score, true);
const long = "a/".repeat(60) + "b";
const t0 = Date.now(); M.fuzzyMatch("aaaaaaaaaab", long); eq("fuzzy bounded", Date.now() - t0 < 200, true);

eq("username email field", M.chooseUsername([{ key: "username", value: "jdoe" }, { key: "email", value: "j@d.org" }], "email", "x", -1), "j@d.org");
eq("username text field", M.chooseUsername([{ key: "mail", value: "j@d.org" }, { key: "username", value: "jdoe" }], "text", "x", -1), "jdoe");
eq("username from filename (email)", M.chooseUsername([], "text", "Government/Portal/jane@example.org", -1), "jane@example.org");
eq("username from filename under domain dir", M.chooseUsername([], "text", "Work/example.com/alice", 1), "alice");
eq("no username for domain-named file", M.chooseUsername([], "text", "Acme/erp.acme.de", 1), "");

eq("prune", M.pruneHistory(M.recordUse({}, c, "gone"), ["x"]), { form: {}, host: {}, site: {}, global: {} });
if (failed) { print(`${failed} failed`); System.exit(1); } else print("all passed");

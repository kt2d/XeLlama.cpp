// xellama-gpu-telemetry: a tiny standalone GPU telemetry server for
// the XeLlama Monitor. It reads the xe driver's DRM fdinfo (the
// llama-server process's VRAM footprint and engine busy cycles) and
// the GT frequency sysfs of the Arc cards, and serves the latest
// snapshot as JSON. It does not patch llama-server; since v1.5 it
// also serves the monitor web UI and proxies llama-server's data
// endpoints, so the whole monitor lives on one origin.
//
// Why not xpu-smi: on the target machine both cards report
// "survivability mode" and every XPUM metric fails with "Device
// handle not found", while fdinfo/sysfs reads work (the same route
// nvtop uses, and the one run-vram-read-v2.1.sh / run-freq-read-v1.1.sh
// already proved on that machine).
//
// v1.1 (2026-11-21, after the first real run): the target kernel's
// fdinfo has no drm-engine-* keys. It uses the cycles scheme -
// drm-cycles-<engine> / drm-total-cycles-<engine> for rcs/ccs/bcs/
// vcs/vecs - and memory values carry a unit suffix ("12345 kB").
// Busy% per engine class is dcycles/dtotal-cycles; the headline
// busy_pct is the larger of the compute (ccs) and render (rcs)
// ratios, with both also reported separately. The legacy
// drm-engine-render (ns) scheme stays as a fallback.
//
// v1.2 (2026-11-21, after the second real run): on xe, fdinfo's
// drm-total-vram0 is the client's total allocation, not the card
// capacity (v1.1 showed pct=100 with total == resident). Capacity
// now comes from the card's sysfs mem_info_vram_total (bytes);
// when that file is absent, vram_total_gib / vram_pct stay null
// and a note says so.
//
// v1.3 (2026-11-21, after the user's diagnostic paste): the target
// kernel has no mem_info_vram_total anywhere under the card or
// tile dirs, so capacity now comes from the largest PCI BAR in
// /sys/bus/pci/devices/<bdf>/resource (the VRAM aperture; reads
// ~0.5 pt below nvtop's usable figure, close enough for a monitor).
// The same paste proved the cycles scheme works under load
// (3 s window during generation: B60 ccs 97.5%, bcs 88.5%;
// A770 ccs 76.4%) and that the copy engine is a first-class cost
// on this tensor-split rig, so busy_bcs_pct is reported too.
//
// v1.4 (2026-11-21, fourth real run): the B60's largest BAR is
// 32 GiB while its VRAM is 24 GiB, so the BAR heuristic overstates
// that card (it was right for the A770). Known cards now take
// their usable capacity from a small built-in table (nvtop's
// figures from 2026-11-21); the BAR remains the fallback for
// unknown BDFs. vram_total_source in the JSON says which was used.
// v1.4 was confirmed against nvtop on the real machine.
//
// v1.5 (2026-11-21, monitor integration decided by the user): this
// process becomes the monitor's single origin. It proxies
// llama-server's /props, /metrics and /slots (-llama flag) and
// serves the monitor web files from a directory (-web flag). The
// monitor's DEFAULT_BASE becomes its own origin, so no base-URL
// configuration is needed. The TS -> JS build stays out of this
// process: a bundled Dockerfile (node + typescript) is run by the
// launcher script when the sources are newer than the built JS.
//
// Endpoints:
//
//	GET /gpu.json   latest snapshot (Access-Control-Allow-Origin: *)
//	GET /healthz    "ok"
//	GET /           one-line description
//
// Flags:
//
//	-addr     listen address        (default ":11435")
//	-interval sampling interval     (default 2s)
//	-proc     procfs root           (default "/proc"; test override)
//	-sys      sysfs root            (default "/sys"; test override)
//	-pid      llama-server pid      (default 0 = find by cmdline scan)
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

var cardNames = map[string]string{
	"0000:10:00.0": "Arc Pro B60",
	"0000:06:00.0": "Arc A770",
}

// cardCapacityGiB holds usable VRAM (GiB) for the known cards, as
// reported by nvtop on 2026-11-21. It wins over the PCI BAR
// heuristic because the B60's BAR window (32 GiB) is larger than
// its physical VRAM (24 GiB).
var cardCapacityGiB = map[string]float64{
	"0000:10:00.0": 23.97,
	"0000:06:00.0": 15.91,
}

// cardOrder lists the BDFs in display order; unknown BDFs follow,
// sorted by address.
var cardOrder = []string{"0000:10:00.0", "0000:06:00.0"}

type device struct {
	BDF             string   `json:"bdf"`
	Name            string   `json:"name"`
	VRAMResidentGiB *float64 `json:"vram_resident_gib"`
	VRAMTotalGiB    *float64 `json:"vram_total_gib"`
	VRAMTotalSource string   `json:"vram_total_source"`
	VRAMPct         *float64 `json:"vram_pct"`
	BusyPct         *float64 `json:"busy_pct"`
	BusyCCSPct      *float64 `json:"busy_ccs_pct"`
	BusyRCSPct      *float64 `json:"busy_rcs_pct"`
	BusyBCSPct      *float64 `json:"busy_bcs_pct"`
	FreqActMHz      *int     `json:"freq_act_mhz"`
	FreqCurMHz      *int     `json:"freq_cur_mhz"`
	FreqMaxMHz      *int     `json:"freq_max_mhz"`
	FreqRP0MHz      *int     `json:"freq_rp0_mhz"`
}

type snapshot struct {
	TS        string   `json:"ts"`
	ServerPID *int     `json:"server_pid"`
	Devices   []device `json:"devices"`
	Notes     []string `json:"notes"`
}

type fdAgg struct {
	residentKB  uint64
	totalKB     uint64
	cycles      map[string]uint64 // drm-cycles-<engine>, summed over fds
	totalCycles map[string]uint64 // drm-total-cycles-<engine>, max over fds
	engineNS    uint64            // legacy drm-engine-render, summed
	hasCycles   bool
	hasEngineNS bool
}

type freqInfo struct {
	act, cur, max, rp0 *int
}

type sampler struct {
	procRoot string
	sysRoot  string
	pidFlag  int

	mu         sync.Mutex
	latest     snapshot
	prevCycles map[string]map[string]uint64
	prevTotal  map[string]map[string]uint64
	prevEngNS  map[string]uint64
	prevWall   time.Time
	havePrev   bool
}

func round1(x float64) float64 { return math.Round(x*10) / 10 }
func round2(x float64) float64 { return math.Round(x*100) / 100 }

func fptr(x float64) *float64 { return &x }
func iptr(x int) *int         { return &x }

// parseNum reads the first whitespace-separated field as an integer;
// fdinfo values may carry a unit suffix ("18874368 kB").
func parseNum(v string) uint64 {
	f := strings.Fields(v)
	if len(f) == 0 {
		return 0
	}
	n, _ := strconv.ParseUint(f[0], 10, 64)
	return n
}

// findServerPID scans procfs cmdlines for llama-server.
func (s *sampler) findServerPID() (int, bool) {
	if s.pidFlag > 0 {
		return s.pidFlag, true
	}
	ents, err := os.ReadDir(s.procRoot)
	if err != nil {
		return 0, false
	}
	for _, e := range ents {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		b, err := os.ReadFile(filepath.Join(s.procRoot, e.Name(), "cmdline"))
		if err != nil {
			continue
		}
		if strings.Contains(string(b), "llama-server") {
			return pid, true
		}
	}
	return 0, false
}

// readFDInfo aggregates the server's DRM fdinfo per BDF. It also
// returns the set of keys seen, so an unexpected key layout can be
// diagnosed from the snapshot notes.
func (s *sampler) readFDInfo(pid int) (map[string]*fdAgg, map[string]bool) {
	agg := map[string]*fdAgg{}
	keys := map[string]bool{}
	dir := filepath.Join(s.procRoot, strconv.Itoa(pid), "fdinfo")
	ents, err := os.ReadDir(dir)
	if err != nil {
		return agg, keys
	}
	for _, e := range ents {
		b, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}
		var pdev string
		a := &fdAgg{cycles: map[string]uint64{}, totalCycles: map[string]uint64{}}
		for _, line := range strings.Split(string(b), "\n") {
			k, v, ok := strings.Cut(line, ":")
			if !ok {
				continue
			}
			keys[k] = true
			v = strings.TrimSpace(v)
			switch {
			case k == "drm-pdev":
				pdev = v
			case k == "drm-resident-vram0":
				a.residentKB = parseNum(v)
			case k == "drm-total-vram0":
				a.totalKB = parseNum(v)
			case strings.HasPrefix(k, "drm-cycles-"):
				a.cycles[strings.TrimPrefix(k, "drm-cycles-")] = parseNum(v)
				a.hasCycles = true
			case strings.HasPrefix(k, "drm-total-cycles-"):
				a.totalCycles[strings.TrimPrefix(k, "drm-total-cycles-")] = parseNum(v)
			case k == "drm-engine-render":
				a.engineNS = parseNum(v)
				a.hasEngineNS = true
			}
		}
		if pdev == "" {
			continue
		}
		t := agg[pdev]
		if t == nil {
			t = &fdAgg{cycles: map[string]uint64{}, totalCycles: map[string]uint64{}}
			agg[pdev] = t
		}
		t.residentKB += a.residentKB
		if a.totalKB > t.totalKB {
			t.totalKB = a.totalKB
		}
		for e, c := range a.cycles {
			t.cycles[e] += c
		}
		for e, c := range a.totalCycles {
			if c > t.totalCycles[e] {
				t.totalCycles[e] = c
			}
		}
		t.engineNS += a.engineNS
		t.hasCycles = t.hasCycles || a.hasCycles
		t.hasEngineNS = t.hasEngineNS || a.hasEngineNS
	}
	return agg, keys
}

func readIntFile(path string) *int {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	n, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil {
		return nil
	}
	return &n
}

// readFreq maps BDF -> GT frequencies from the xe sysfs layout
// (<card>/device/tile*/gt*/freq0), skipping connector nodes.
func (s *sampler) readFreq() map[string]*freqInfo {
	out := map[string]*freqInfo{}
	cards, _ := filepath.Glob(filepath.Join(s.sysRoot, "class", "drm", "card*"))
	for _, card := range cards {
		if strings.Contains(filepath.Base(card), "-") {
			continue // connector node, not a GPU
		}
		target, err := os.Readlink(filepath.Join(card, "device"))
		if err != nil {
			continue
		}
		bdf := filepath.Base(target)
		dirs, _ := filepath.Glob(filepath.Join(card, "device", "tile*", "gt*", "freq0"))
		if len(dirs) == 0 {
			continue
		}
		d := dirs[0]
		out[bdf] = &freqInfo{
			act: readIntFile(filepath.Join(d, "act_freq")),
			cur: readIntFile(filepath.Join(d, "cur_freq")),
			max: readIntFile(filepath.Join(d, "max_freq")),
			rp0: readIntFile(filepath.Join(d, "rp0_freq")),
		}
	}
	return out
}

// readCapacity returns the card's VRAM capacity in bytes from the
// largest BAR in the PCI resource file (the VRAM aperture), or nil
// when no usable BAR line exists.
func (s *sampler) readCapacity(bdf string) *uint64 {
	b, err := os.ReadFile(filepath.Join(s.sysRoot, "bus", "pci", "devices", bdf, "resource"))
	if err != nil {
		return nil
	}
	var best uint64
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.Fields(line)
		if len(f) < 2 {
			continue
		}
		start, err1 := strconv.ParseUint(f[0], 0, 64)
		end, err2 := strconv.ParseUint(f[1], 0, 64)
		if err1 != nil || err2 != nil || start == 0 || end < start {
			continue
		}
		if sz := end - start + 1; sz > best {
			best = sz
		}
	}
	if best == 0 {
		return nil
	}
	return &best
}

// busyRatios computes per-engine busy percentages for one BDF from
// the cycles deltas against the previous sample.
func (s *sampler) busyRatios(bdf string, a *fdAgg, wallNS uint64) (ccs, rcs, bcs, headline *float64) {
	if !s.havePrev {
		return nil, nil, nil, nil
	}
	ratio := func(engine string) *float64 {
		prevC, ok1 := s.prevCycles[bdf][engine]
		prevT, ok2 := s.prevTotal[bdf][engine]
		if !ok1 || !ok2 {
			return nil
		}
		dc := a.cycles[engine] - prevC
		dt := a.totalCycles[engine] - prevT
		if dt == 0 {
			return nil
		}
		r := 100 * float64(dc) / float64(dt)
		if r > 100 {
			r = 100
		}
		return fptr(round1(r))
	}
	ccs = ratio("ccs")
	rcs = ratio("rcs")
	bcs = ratio("bcs")
	switch {
	case ccs != nil && rcs != nil:
		if *ccs >= *rcs {
			headline = ccs
		} else {
			headline = rcs
		}
	case ccs != nil:
		headline = ccs
	case rcs != nil:
		headline = rcs
	case a.hasEngineNS && wallNS > 0:
		// Legacy fallback: engine busy time in ns over wall time.
		if prev, had := s.prevEngNS[bdf]; had {
			r := 100 * float64(a.engineNS-prev) / float64(wallNS)
			if r > 100 {
				r = 100
			}
			headline = fptr(round1(r))
		}
	}
	return ccs, rcs, bcs, headline
}

func (s *sampler) sample() snapshot {
	now := time.Now()
	snap := snapshot{TS: now.Format(time.RFC3339), Notes: []string{}}

	pid, ok := s.findServerPID()
	var agg map[string]*fdAgg
	var keys map[string]bool
	if ok {
		snap.ServerPID = iptr(pid)
		agg, keys = s.readFDInfo(pid)
	} else {
		snap.Notes = append(snap.Notes, "llama-server process not found; VRAM and busy are per-process and stay null")
		agg = map[string]*fdAgg{}
	}
	freqs := s.readFreq()

	bdfSet := map[string]bool{}
	for bdf := range agg {
		bdfSet[bdf] = true
	}
	for bdf := range freqs {
		bdfSet[bdf] = true
	}
	bdfs := make([]string, 0, len(bdfSet))
	for bdf := range bdfSet {
		bdfs = append(bdfs, bdf)
	}
	sort.Slice(bdfs, func(i, j int) bool {
		oi, oj := len(cardOrder), len(cardOrder)
		for n, b := range cardOrder {
			if bdfs[i] == b {
				oi = n
			}
			if bdfs[j] == b {
				oj = n
			}
		}
		if oi != oj {
			return oi < oj
		}
		return bdfs[i] < bdfs[j]
	})

	wallNS := uint64(now.Sub(s.prevWall).Nanoseconds())
	engineSeen := false
	capacityMissing := false
	newCycles := map[string]map[string]uint64{}
	newTotal := map[string]map[string]uint64{}
	newEngNS := map[string]uint64{}
	for _, bdf := range bdfs {
		d := device{BDF: bdf, Name: cardNames[bdf]}
		if a := agg[bdf]; a != nil {
			res := float64(a.residentKB) / 1048576.0
			d.VRAMResidentGiB = fptr(round2(res))
			var tot *float64
			if gib, known := cardCapacityGiB[bdf]; known {
				tot = fptr(gib)
				d.VRAMTotalSource = "table"
			} else if capBytes := s.readCapacity(bdf); capBytes != nil {
				tot = fptr(float64(*capBytes) / 1073741824.0)
				d.VRAMTotalSource = "bar"
			}
			if tot != nil {
				d.VRAMTotalGiB = fptr(round2(*tot))
				d.VRAMPct = fptr(round1(100 * res / *tot))
			} else {
				capacityMissing = true
			}
			if a.hasCycles || a.hasEngineNS {
				engineSeen = true
				newCycles[bdf] = a.cycles
				newTotal[bdf] = a.totalCycles
				newEngNS[bdf] = a.engineNS
				d.BusyCCSPct, d.BusyRCSPct, d.BusyBCSPct, d.BusyPct = s.busyRatios(bdf, a, wallNS)
			}
		}
		if f := freqs[bdf]; f != nil {
			d.FreqActMHz = f.act
			d.FreqCurMHz = f.cur
			d.FreqMaxMHz = f.max
			d.FreqRP0MHz = f.rp0
		}
		snap.Devices = append(snap.Devices, d)
	}
	if capacityMissing {
		snap.Notes = append(snap.Notes,
			"capacity unknown for this BDF (not in the built-in table and no usable PCI BAR in /sys/bus/pci/devices/<bdf>/resource); vram_total_gib and vram_pct stay null")
	}
	if ok && len(agg) > 0 && !engineSeen {
		seen := make([]string, 0, len(keys))
		for k := range keys {
			seen = append(seen, k)
		}
		sort.Strings(seen)
		snap.Notes = append(snap.Notes,
			"no drm-cycles-* or drm-engine-* key in fdinfo, busy_pct stays null; keys seen: "+strings.Join(seen, ", "))
	}
	s.prevCycles = newCycles
	s.prevTotal = newTotal
	s.prevEngNS = newEngNS
	s.prevWall = now
	s.havePrev = true
	return snap
}

func (s *sampler) run(interval time.Duration) {
	for {
		snap := s.sample()
		s.mu.Lock()
		s.latest = snap
		s.mu.Unlock()
		time.Sleep(interval)
	}
}

func (s *sampler) current() snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.latest
}

func main() {
	addr := flag.String("addr", ":11435", "listen address")
	interval := flag.Duration("interval", 2*time.Second, "sampling interval")
	proc := flag.String("proc", "/proc", "procfs root")
	sys := flag.String("sys", "/sys", "sysfs root")
	pid := flag.Int("pid", 0, "llama-server pid (0 = auto-find)")
	llama := flag.String("llama", "http://127.0.0.1:11434", "llama-server base URL to proxy /props, /metrics, /slots from")
	web := flag.String("web", "", "serve the monitor web files from this directory at / (empty = disabled)")
	flag.Parse()

	s := &sampler{
		procRoot:   *proc,
		sysRoot:    *sys,
		pidFlag:    *pid,
		prevCycles: map[string]map[string]uint64{},
		prevTotal:  map[string]map[string]uint64{},
		prevEngNS:  map[string]uint64{},
	}
	go s.run(*interval)

	mux := http.NewServeMux()
	mux.HandleFunc("/gpu.json", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		enc := json.NewEncoder(w)
		_ = enc.Encode(s.current())
	})
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		_, _ = fmt.Fprintln(w, "ok")
	})
	// Proxy llama-server's data endpoints so the monitor page,
	// served from this same origin, needs no base-URL setup.
	proxyClient := &http.Client{Timeout: 10 * time.Second}
	proxy := func(w http.ResponseWriter, r *http.Request) {
		up, err := http.NewRequestWithContext(r.Context(), http.MethodGet,
			strings.TrimSuffix(*llama, "/")+r.URL.RequestURI(), nil)
		if err != nil {
			http.Error(w, "bad upstream URL", http.StatusInternalServerError)
			return
		}
		resp, err := proxyClient.Do(up)
		if err != nil {
			http.Error(w, "llama-server unreachable: "+err.Error(), http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()
		if ct := resp.Header.Get("Content-Type"); ct != "" {
			w.Header().Set("Content-Type", ct)
		}
		w.WriteHeader(resp.StatusCode)
		_, _ = io.Copy(w, resp.Body)
	}
	for _, p := range []string{"/props", "/metrics", "/slots"} {
		mux.HandleFunc(p, proxy)
	}
	if *web != "" {
		mux.Handle("/", http.FileServer(http.Dir(*web)))
	} else {
		mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			_, _ = fmt.Fprintln(w, "xellama-gpu-telemetry: GET /gpu.json")
		})
	}

	log.Printf("xellama-gpu-telemetry v1.5 listening on %s (interval %s, llama %s, web %q)", *addr, *interval, *llama, *web)
	log.Fatal(http.ListenAndServe(*addr, mux))
}

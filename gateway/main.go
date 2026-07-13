package main

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

// Edge router implementing path-based Strangler Fig cutover.
// Config decides which prefixes hit Go microservices vs the legacy monolith.

type Config struct {
	ListenAddr   string
	LegacyURL    string
	OrdersURL    string
	InventoryURL string
	OrdersNew    bool // true → route /orders* to orders-go
	InventoryNew bool // true → route /inventory* to inventory-go
	HTTPClient   *http.Client
}

func loadConfig() Config {
	return Config{
		ListenAddr:   ":" + envOr("PORT", "8000"),
		LegacyURL:    strings.TrimRight(envOr("LEGACY_URL", "http://127.0.0.1:8080"), "/"),
		OrdersURL:    strings.TrimRight(envOr("ORDERS_URL", "http://127.0.0.1:8081"), "/"),
		InventoryURL: strings.TrimRight(envOr("INVENTORY_URL", "http://127.0.0.1:8082"), "/"),
		// Default demo: orders already strangled; inventory still on legacy.
		OrdersNew:    envBool("ROUTE_ORDERS_NEW", true),
		InventoryNew: envBool("ROUTE_INVENTORY_NEW", false),
		HTTPClient: &http.Client{
			Timeout: 10 * time.Second,
		},
	}
}

type Gateway struct {
	cfg Config
}

func (g *Gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	if path == "/health" {
		writeJSON(w, http.StatusOK, map[string]any{
			"status":  "ok",
			"service": "gateway",
			"routing": map[string]string{
				"orders":    routeLabel(g.cfg.OrdersNew, "orders-go", "legacy"),
				"inventory": routeLabel(g.cfg.InventoryNew, "inventory-go", "legacy"),
			},
		})
		return
	}
	if path == "/__routes" {
		writeJSON(w, http.StatusOK, map[string]any{
			"orders":    routeLabel(g.cfg.OrdersNew, "orders-go", "legacy"),
			"inventory": routeLabel(g.cfg.InventoryNew, "inventory-go", "legacy"),
			"targets": map[string]string{
				"legacy":    g.cfg.LegacyURL,
				"orders":    g.cfg.OrdersURL,
				"inventory": g.cfg.InventoryURL,
			},
		})
		return
	}

	target := g.pickTarget(path)
	g.proxy(w, r, target)
}

func (g *Gateway) pickTarget(path string) string {
	if strings.HasPrefix(path, "/orders") {
		if g.cfg.OrdersNew {
			return g.cfg.OrdersURL
		}
		return g.cfg.LegacyURL
	}
	if strings.HasPrefix(path, "/inventory") {
		if g.cfg.InventoryNew {
			return g.cfg.InventoryURL
		}
		return g.cfg.LegacyURL
	}
	// Everything else falls through to legacy (health of backends, future APIs).
	return g.cfg.LegacyURL
}

func (g *Gateway) proxy(w http.ResponseWriter, r *http.Request, targetBase string) {
	url := targetBase + r.URL.Path
	if r.URL.RawQuery != "" {
		url += "?" + r.URL.RawQuery
	}

	var body io.Reader
	if r.Body != nil {
		body = r.Body
	}
	req, err := http.NewRequestWithContext(r.Context(), r.Method, url, body)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "proxy build failed"})
		return
	}
	// Forward relevant headers.
	for k, vals := range r.Header {
		if strings.EqualFold(k, "Host") {
			continue
		}
		for _, v := range vals {
			req.Header.Add(k, v)
		}
	}
	if req.Header.Get("Content-Type") == "" && (r.Method == http.MethodPost || r.Method == http.MethodPut || r.Method == http.MethodPatch) {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := g.cfg.HTTPClient.Do(req)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "upstream unreachable: " + err.Error()})
		return
	}
	defer resp.Body.Close()

	for k, vals := range resp.Header {
		// Skip hop-by-hop; let Content-Length be recomputed by Write.
		if strings.EqualFold(k, "Content-Length") {
			continue
		}
		for _, v := range vals {
			w.Header().Add(k, v)
		}
	}
	w.Header().Set("X-Gateway-Target", targetBase)
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("X-Served-By", "gateway")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func routeLabel(useNew bool, newName, oldName string) string {
	if useNew {
		return newName
	}
	return oldName
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func envBool(k string, def bool) bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv(k)))
	if v == "" {
		return def
	}
	switch v {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	default:
		return def
	}
}

func main() {
	cfg := loadConfig()
	gw := &Gateway{cfg: cfg}
	log.Printf("gateway listening on %s", cfg.ListenAddr)
	log.Printf("  orders    → %s", routeLabel(cfg.OrdersNew, cfg.OrdersURL, cfg.LegacyURL))
	log.Printf("  inventory → %s", routeLabel(cfg.InventoryNew, cfg.InventoryURL, cfg.LegacyURL))
	if err := http.ListenAndServe(cfg.ListenAddr, gw); err != nil {
		log.Fatal(err)
	}
}

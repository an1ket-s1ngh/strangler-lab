package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

// Order domain service — extracted slice of the legacy monolith.
// Speaks the same HTTP contract as legacy /orders so the gateway can cut over safely.

type OrderItem struct {
	SKU      string `json:"sku"`
	Quantity int    `json:"quantity"`
}

type Order struct {
	ID         string      `json:"id"`
	CustomerID string      `json:"customerId"`
	Items      []OrderItem `json:"items"`
	Status     string      `json:"status"`
	CreatedAt  string      `json:"createdAt"`
}

type createOrderRequest struct {
	CustomerID string      `json:"customerId"`
	Items      []OrderItem `json:"items"`
}

type errorBody struct {
	Error string `json:"error"`
}

// InventoryClient reserves stock in the inventory service (or legacy via gateway).
type InventoryClient interface {
	Reserve(sku string, quantity int) error
}

type HTTPInventoryClient struct {
	BaseURL    string
	HTTPClient *http.Client
}

func (c *HTTPInventoryClient) Reserve(sku string, quantity int) error {
	payload, err := json.Marshal(map[string]int{"quantity": quantity})
	if err != nil {
		return err
	}
	url := strings.TrimRight(c.BaseURL, "/") + "/inventory/" + sku + "/reserve"
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return nil
	}
	var eb errorBody
	if err := json.Unmarshal(body, &eb); err != nil || eb.Error == "" {
		eb.Error = fmt.Sprintf("inventory reserve failed (%d)", resp.StatusCode)
	}
	return &httpError{status: resp.StatusCode, msg: eb.Error}
}

type httpError struct {
	status int
	msg    string
}

func (e *httpError) Error() string { return e.msg }

type Store struct {
	mu     sync.RWMutex
	orders map[string]Order
	inv    InventoryClient
}

func NewStore(inv InventoryClient) *Store {
	return &Store{
		orders: make(map[string]Order),
		inv:    inv,
	}
}

func (s *Store) Create(req createOrderRequest) (Order, error) {
	if req.CustomerID == "" {
		return Order{}, &httpError{status: http.StatusBadRequest, msg: "customerId (string) required"}
	}
	if len(req.Items) == 0 {
		return Order{}, &httpError{status: http.StatusBadRequest, msg: "items (non-empty array) required"}
	}
	for _, it := range req.Items {
		if it.SKU == "" {
			return Order{}, &httpError{status: http.StatusBadRequest, msg: "each item needs sku"}
		}
		if it.Quantity < 1 {
			return Order{}, &httpError{status: http.StatusBadRequest, msg: "each item needs quantity >= 1"}
		}
	}

	for _, it := range req.Items {
		if err := s.inv.Reserve(it.SKU, it.Quantity); err != nil {
			return Order{}, err
		}
	}

	o := Order{
		ID:         uuid.NewString(),
		CustomerID: req.CustomerID,
		Items:      append([]OrderItem(nil), req.Items...),
		Status:     "confirmed",
		CreatedAt:  time.Now().UTC().Format(time.RFC3339),
	}

	s.mu.Lock()
	s.orders[o.ID] = o
	s.mu.Unlock()
	return o, nil
}

func (s *Store) Get(id string) (Order, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	o, ok := s.orders[id]
	return o, ok
}

type Server struct {
	store *Store
	mux   *http.ServeMux
}

func NewServer(store *Store) *Server {
	s := &Server{store: store, mux: http.NewServeMux()}
	s.mux.HandleFunc("GET /health", s.handleHealth)
	s.mux.HandleFunc("POST /orders", s.handleCreateOrder)
	s.mux.HandleFunc("GET /orders/{id}", s.handleGetOrder)
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mux.ServeHTTP(w, r)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("X-Served-By", "orders-go")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "service": "orders-go"})
}

func (s *Server) handleCreateOrder(w http.ResponseWriter, r *http.Request) {
	var req createOrderRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody{Error: "invalid JSON body"})
		return
	}
	order, err := s.store.Create(req)
	if err != nil {
		if he, ok := err.(*httpError); ok {
			writeJSON(w, he.status, errorBody{Error: he.msg})
			return
		}
		writeJSON(w, http.StatusBadGateway, errorBody{Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, order)
}

func (s *Server) handleGetOrder(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	order, ok := s.store.Get(id)
	if !ok {
		writeJSON(w, http.StatusNotFound, errorBody{Error: "order not found"})
		return
	}
	writeJSON(w, http.StatusOK, order)
}

func main() {
	port := envOr("PORT", "8081")
	// Point at legacy (or inventory-go) for reservations during partial cutover.
	invURL := envOr("INVENTORY_URL", "http://127.0.0.1:8080")

	inv := &HTTPInventoryClient{
		BaseURL: invURL,
		HTTPClient: &http.Client{
			Timeout: 5 * time.Second,
		},
	}
	store := NewStore(inv)
	srv := NewServer(store)

	addr := ":" + port
	log.Printf("orders-go listening on %s (inventory=%s)", addr, invURL)
	if err := http.ListenAndServe(addr, srv); err != nil {
		log.Fatal(err)
	}
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"sync"
)

// Inventory domain service — second strangler slice.
// Same HTTP contract as legacy /inventory so cutover is config-driven.

type Stock struct {
	SKU      string `json:"sku"`
	Name     string `json:"name"`
	Quantity int    `json:"quantity"`
}

type reserveRequest struct {
	Quantity int `json:"quantity"`
}

type reserveResponse struct {
	SKU       string `json:"sku"`
	Reserved  int    `json:"reserved"`
	Remaining int    `json:"remaining"`
}

type errorBody struct {
	Error string `json:"error"`
}

type Store struct {
	mu    sync.Mutex
	stock map[string]*Stock
}

func NewStore() *Store {
	return &Store{
		stock: map[string]*Stock{
			"SKU-COFFEE-01":  {SKU: "SKU-COFFEE-01", Name: "House Blend Beans 1kg", Quantity: 100},
			"SKU-MUG-12":     {SKU: "SKU-MUG-12", Name: "Ceramic Mug 12oz", Quantity: 40},
			"SKU-FILTER-100": {SKU: "SKU-FILTER-100", Name: "Paper Filters (100pk)", Quantity: 200},
		},
	}
}

func (s *Store) Get(sku string) (Stock, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, ok := s.stock[sku]
	if !ok {
		return Stock{}, false
	}
	return *st, true
}

func (s *Store) Reserve(sku string, qty int) (reserveResponse, error) {
	if qty < 1 {
		return reserveResponse{}, &httpError{status: http.StatusBadRequest, msg: "quantity (integer >= 1) required"}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	st, ok := s.stock[sku]
	if !ok {
		return reserveResponse{}, &httpError{status: http.StatusNotFound, msg: "unknown sku: " + sku}
	}
	if st.Quantity < qty {
		return reserveResponse{}, &httpError{
			status: http.StatusConflict,
			msg:    fmt.Sprintf("insufficient stock for %s: have %d, need %d", sku, st.Quantity, qty),
		}
	}
	st.Quantity -= qty
	return reserveResponse{SKU: st.SKU, Reserved: qty, Remaining: st.Quantity}, nil
}

type httpError struct {
	status int
	msg    string
}

func (e *httpError) Error() string { return e.msg }

type Server struct {
	store *Store
	mux   *http.ServeMux
}

func NewServer(store *Store) *Server {
	s := &Server{store: store, mux: http.NewServeMux()}
	s.mux.HandleFunc("GET /health", s.handleHealth)
	s.mux.HandleFunc("GET /inventory/{sku}", s.handleGet)
	s.mux.HandleFunc("POST /inventory/{sku}/reserve", s.handleReserve)
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mux.ServeHTTP(w, r)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("X-Served-By", "inventory-go")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "service": "inventory-go"})
}

func (s *Server) handleGet(w http.ResponseWriter, r *http.Request) {
	sku := r.PathValue("sku")
	st, ok := s.store.Get(sku)
	if !ok {
		writeJSON(w, http.StatusNotFound, errorBody{Error: "sku not found"})
		return
	}
	writeJSON(w, http.StatusOK, st)
}

func (s *Server) handleReserve(w http.ResponseWriter, r *http.Request) {
	sku := r.PathValue("sku")
	var req reserveRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody{Error: "invalid JSON body"})
		return
	}
	resp, err := s.store.Reserve(sku, req.Quantity)
	if err != nil {
		if he, ok := err.(*httpError); ok {
			writeJSON(w, he.status, errorBody{Error: he.msg})
			return
		}
		writeJSON(w, http.StatusInternalServerError, errorBody{Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

func main() {
	port := envOr("PORT", "8082")
	store := NewStore()
	srv := NewServer(store)
	addr := ":" + port
	log.Printf("inventory-go listening on %s", addr)
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

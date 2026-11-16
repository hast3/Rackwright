//! Rackwright web server: JSON API (see web/API.md) plus static front-end hosting.
//! The geometry/routing code is the desktop app's, included unchanged via `#[path]`.
#![allow(dead_code)]

#[path = "../../../rackwright-tauri/src-tauri/src/model.rs"]
pub mod model;
#[path = "../../../rackwright-tauri/src-tauri/src/geom.rs"]
pub mod geom;
#[path = "../../../rackwright-tauri/src-tauri/src/router.rs"]
pub mod router;

use std::path::Path as FsPath;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, post};
use axum::{Json, Router};
use rand::RngCore;
use rusqlite::{params, Connection, OptionalExtension};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tower_http::services::{ServeDir, ServeFile};

const SESSION_SECS: i64 = 30 * 24 * 3600;
const COOKIE: &str = "rw_session";
const MIN_PW: usize = 8;
const BODY_LIMIT: usize = 20 * 1024 * 1024;

// ---------------------------------------------------------------- state / errors

pub struct AppState {
    db: Mutex<Connection>,
}

impl AppState {
    fn db(&self) -> MutexGuard<'_, Connection> {
        self.db.lock().unwrap_or_else(|e| e.into_inner())
    }
}

type Shared = Arc<AppState>;

pub struct ApiError {
    status: StatusCode,
    body: Value,
}

impl ApiError {
    fn new(status: StatusCode, msg: impl Into<String>) -> Self {
        ApiError { status, body: json!({ "error": msg.into() }) }
    }
    fn bad(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, msg)
    }
}

impl From<rusqlite::Error> for ApiError {
    fn from(e: rusqlite::Error) -> Self {
        eprintln!("database error: {e}");
        ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "Database error")
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(self.body)).into_response()
    }
}

type ApiResult = Result<Response, ApiError>;

fn json_ok<T: Serialize>(v: &T) -> Response {
    Json(v).into_response()
}

fn parse<T: DeserializeOwned>(bytes: &Bytes) -> Result<T, ApiError> {
    serde_json::from_slice(bytes).map_err(|e| ApiError::bad(format!("Invalid request body: {e}")))
}

fn now_rfc3339() -> String {
    use time::format_description::well_known::Rfc3339;
    let now = time::OffsetDateTime::now_utc();
    let now = now.replace_nanosecond(0).unwrap_or(now);
    now.format(&Rfc3339).unwrap_or_default()
}

fn now_unix() -> i64 {
    time::OffsetDateTime::now_utc().unix_timestamp()
}

// ---------------------------------------------------------------- users / auth helpers

#[derive(Serialize, Clone, Debug)]
pub struct User {
    id: i64,
    email: String,
    name: String,
    is_admin: bool,
}

fn row_user(r: &rusqlite::Row) -> rusqlite::Result<User> {
    Ok(User { id: r.get(0)?, email: r.get(1)?, name: r.get(2)?, is_admin: r.get::<_, i64>(3)? != 0 })
}

const USER_COLS: &str = "id, email, name, is_admin";

fn norm_email(s: &str) -> Result<String, ApiError> {
    let e = s.trim().to_lowercase();
    if e.len() < 3 || e.len() > 254 || !e.contains('@') {
        return Err(ApiError::bad("Enter a valid email address"));
    }
    Ok(e)
}

fn norm_name(s: &str) -> Result<String, ApiError> {
    let n = s.trim().to_string();
    if n.is_empty() {
        return Err(ApiError::bad("Name is required"));
    }
    Ok(n)
}

fn check_pw(pw: &str) -> Result<(), ApiError> {
    if pw.chars().count() < MIN_PW {
        return Err(ApiError::bad(format!("Password must be at least {MIN_PW} characters")));
    }
    Ok(())
}

fn hash_pw(pw: &str) -> Result<String, ApiError> {
    let mut raw = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut raw);
    let salt = SaltString::encode_b64(&raw)
        .map_err(|_| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "Could not hash password"))?;
    Argon2::default()
        .hash_password(pw.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|_| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "Could not hash password"))
}

fn verify_pw(hash: &str, pw: &str) -> bool {
    match PasswordHash::new(hash) {
        Ok(h) => Argon2::default().verify_password(pw.as_bytes(), &h).is_ok(),
        Err(_) => false,
    }
}

fn new_token() -> String {
    let mut b = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut b);
    hex::encode(b)
}

fn hash_token(t: &str) -> String {
    hex::encode(Sha256::digest(t.as_bytes()))
}

fn create_session(conn: &Connection, user_id: i64) -> Result<String, ApiError> {
    let now = now_unix();
    conn.execute("DELETE FROM sessions WHERE expires_at <= ?1", params![now])?;
    let token = new_token();
    conn.execute(
        "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?1, ?2, ?3)",
        params![hash_token(&token), user_id, now + SESSION_SECS],
    )?;
    Ok(token)
}

fn session_cookie(token: &str) -> String {
    format!("{COOKIE}={token}; HttpOnly; SameSite=Lax; Path=/; Max-Age={SESSION_SECS}")
}

fn clear_cookie() -> String {
    format!("{COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0")
}

fn with_cookie(cookie: String, mut resp: Response) -> Response {
    if let Ok(v) = HeaderValue::from_str(&cookie) {
        resp.headers_mut().append(header::SET_COOKIE, v);
    }
    resp
}

fn token_from_headers(headers: &HeaderMap) -> Option<String> {
    for v in headers.get_all(header::COOKIE) {
        let Ok(s) = v.to_str() else { continue };
        for part in s.split(';') {
            if let Some(t) = part.trim().strip_prefix("rw_session=") {
                if !t.is_empty() {
                    return Some(t.to_string());
                }
            }
        }
    }
    None
}

fn unauthorized() -> ApiError {
    ApiError::new(StatusCode::UNAUTHORIZED, "Not signed in")
}

fn auth(state: &AppState, headers: &HeaderMap) -> Result<User, ApiError> {
    let token = token_from_headers(headers).ok_or_else(unauthorized)?;
    let conn = state.db();
    let user = conn
        .query_row(
            "SELECT u.id, u.email, u.name, u.is_admin FROM sessions s JOIN users u ON u.id = s.user_id \
             WHERE s.token_hash = ?1 AND s.expires_at > ?2",
            params![hash_token(&token), now_unix()],
            row_user,
        )
        .optional()?;
    user.ok_or_else(unauthorized)
}

fn auth_admin(state: &AppState, headers: &HeaderMap) -> Result<User, ApiError> {
    let u = auth(state, headers)?;
    if !u.is_admin {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Administrator access required"));
    }
    Ok(u)
}

fn admin_count(conn: &Connection) -> Result<i64, ApiError> {
    Ok(conn.query_row("SELECT COUNT(*) FROM users WHERE is_admin = 1", [], |r| r.get(0))?)
}

fn get_user(conn: &Connection, id: i64) -> Result<Option<User>, ApiError> {
    Ok(conn
        .query_row(&format!("SELECT {USER_COLS} FROM users WHERE id = ?1"), params![id], row_user)
        .optional()?)
}

// ---------------------------------------------------------------- setup / sign-in handlers

async fn healthz() -> &'static str {
    "ok"
}

async fn api_not_found() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "Not found")
}

async fn get_setup(State(st): State<Shared>) -> ApiResult {
    let n: i64 = st.db().query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0))?;
    Ok(json_ok(&json!({ "needs_setup": n == 0 })))
}

#[derive(Deserialize)]
struct SetupReq {
    email: String,
    name: String,
    password: String,
}

fn do_setup(st: &AppState, req: SetupReq) -> Result<(User, String), ApiError> {
    let email = norm_email(&req.email)?;
    let name = norm_name(&req.name)?;
    check_pw(&req.password)?;
    let conn = st.db();
    let n: i64 = conn.query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0))?;
    if n > 0 {
        return Err(ApiError::new(StatusCode::CONFLICT, "Setup has already been completed"));
    }
    let pw_hash = hash_pw(&req.password)?;
    conn.execute(
        "INSERT INTO users (email, name, pw_hash, is_admin, created_at) VALUES (?1, ?2, ?3, 1, ?4)",
        params![email, name, pw_hash, now_rfc3339()],
    )?;
    let id = conn.last_insert_rowid();
    let token = create_session(&conn, id)?;
    let user = get_user(&conn, id)?.ok_or_else(|| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "User missing"))?;
    Ok((user, token))
}

async fn post_setup(State(st): State<Shared>, body: Bytes) -> ApiResult {
    let req: SetupReq = parse(&body)?;
    let (user, token) = do_setup(&st, req)?;
    Ok(with_cookie(session_cookie(&token), json_ok(&user)))
}

#[derive(Deserialize)]
struct LoginReq {
    email: String,
    password: String,
}

/// Ok(None) means wrong email or password.
fn do_login(st: &AppState, req: &LoginReq) -> Result<Option<(User, String)>, ApiError> {
    let email = req.email.trim().to_lowercase();
    let found: Option<(User, String)> = {
        let conn = st.db();
        conn.query_row(
            "SELECT id, email, name, is_admin, pw_hash FROM users WHERE email = ?1",
            params![email],
            |r| Ok((row_user(r)?, r.get::<_, String>(4)?)),
        )
        .optional()?
    };
    let Some((user, pw_hash)) = found else { return Ok(None) };
    if !verify_pw(&pw_hash, &req.password) {
        return Ok(None);
    }
    let token = create_session(&st.db(), user.id)?;
    Ok(Some((user, token)))
}

async fn post_login(State(st): State<Shared>, body: Bytes) -> ApiResult {
    let req: LoginReq = parse(&body)?;
    match do_login(&st, &req)? {
        Some((user, token)) => Ok(with_cookie(session_cookie(&token), json_ok(&user))),
        None => {
            tokio::time::sleep(Duration::from_millis(300)).await;
            Err(ApiError::new(StatusCode::UNAUTHORIZED, "Wrong email or password"))
        }
    }
}

async fn post_logout(State(st): State<Shared>, headers: HeaderMap) -> ApiResult {
    if let Some(t) = token_from_headers(&headers) {
        st.db().execute("DELETE FROM sessions WHERE token_hash = ?1", params![hash_token(&t)])?;
    }
    Ok(with_cookie(clear_cookie(), json_ok(&json!({}))))
}

async fn get_me(State(st): State<Shared>, headers: HeaderMap) -> ApiResult {
    Ok(json_ok(&auth(&st, &headers)?))
}

#[derive(Deserialize)]
struct ChangePwReq {
    current: String,
    new: String,
}

async fn post_me_password(State(st): State<Shared>, headers: HeaderMap, body: Bytes) -> ApiResult {
    let me = auth(&st, &headers)?;
    let req: ChangePwReq = parse(&body)?;
    check_pw(&req.new)?;
    let conn = st.db();
    let cur: String = conn.query_row("SELECT pw_hash FROM users WHERE id = ?1", params![me.id], |r| r.get(0))?;
    if !verify_pw(&cur, &req.current) {
        return Err(ApiError::bad("Current password is wrong"));
    }
    let h = hash_pw(&req.new)?;
    conn.execute("UPDATE users SET pw_hash = ?1 WHERE id = ?2", params![h, me.id])?;
    Ok(json_ok(&json!({})))
}

// ---------------------------------------------------------------- users (admin)

async fn list_users(State(st): State<Shared>, headers: HeaderMap) -> ApiResult {
    auth_admin(&st, &headers)?;
    let conn = st.db();
    let mut stmt = conn.prepare(&format!("SELECT {USER_COLS} FROM users ORDER BY id"))?;
    let users = stmt.query_map([], row_user)?.collect::<Result<Vec<User>, _>>()?;
    Ok(json_ok(&users))
}

#[derive(Deserialize)]
struct NewUserReq {
    email: String,
    name: String,
    password: String,
    #[serde(default)]
    is_admin: bool,
}

async fn create_user(State(st): State<Shared>, headers: HeaderMap, body: Bytes) -> ApiResult {
    auth_admin(&st, &headers)?;
    let req: NewUserReq = parse(&body)?;
    let email = norm_email(&req.email)?;
    let name = norm_name(&req.name)?;
    check_pw(&req.password)?;
    let conn = st.db();
    let taken: i64 = conn.query_row("SELECT COUNT(*) FROM users WHERE email = ?1", params![email], |r| r.get(0))?;
    if taken > 0 {
        return Err(ApiError::new(StatusCode::CONFLICT, "That email is already in use"));
    }
    let h = hash_pw(&req.password)?;
    conn.execute(
        "INSERT INTO users (email, name, pw_hash, is_admin, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![email, name, h, req.is_admin as i64, now_rfc3339()],
    )?;
    let user = get_user(&conn, conn.last_insert_rowid())?
        .ok_or_else(|| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "User missing"))?;
    Ok(json_ok(&user))
}

#[derive(Deserialize)]
struct PatchUserReq {
    name: Option<String>,
    is_admin: Option<bool>,
    password: Option<String>,
}

async fn patch_user(State(st): State<Shared>, headers: HeaderMap, Path(id): Path<i64>, body: Bytes) -> ApiResult {
    auth_admin(&st, &headers)?;
    let req: PatchUserReq = parse(&body)?;
    let conn = st.db();
    let target = get_user(&conn, id)?.ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "User not found"))?;
    if req.is_admin == Some(false) && target.is_admin && admin_count(&conn)? <= 1 {
        return Err(ApiError::bad("You can't remove the last administrator"));
    }
    let name = req.name.as_deref().map(norm_name).transpose()?;
    let pw_hash = match req.password.as_deref() {
        Some(p) => {
            check_pw(p)?;
            Some(hash_pw(p)?)
        }
        None => None,
    };
    if let Some(n) = name {
        conn.execute("UPDATE users SET name = ?1 WHERE id = ?2", params![n, id])?;
    }
    if let Some(a) = req.is_admin {
        conn.execute("UPDATE users SET is_admin = ?1 WHERE id = ?2", params![a as i64, id])?;
    }
    if let Some(h) = pw_hash {
        conn.execute("UPDATE users SET pw_hash = ?1 WHERE id = ?2", params![h, id])?;
    }
    let user = get_user(&conn, id)?.ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "User not found"))?;
    Ok(json_ok(&user))
}

async fn delete_user(State(st): State<Shared>, headers: HeaderMap, Path(id): Path<i64>) -> ApiResult {
    let me = auth_admin(&st, &headers)?;
    if me.id == id {
        return Err(ApiError::bad("You can't delete your own account"));
    }
    let conn = st.db();
    let target = get_user(&conn, id)?.ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "User not found"))?;
    if target.is_admin && admin_count(&conn)? <= 1 {
        return Err(ApiError::bad("You can't delete the last administrator"));
    }
    conn.execute("DELETE FROM sessions WHERE user_id = ?1", params![id])?;
    conn.execute("DELETE FROM users WHERE id = ?1", params![id])?;
    Ok(json_ok(&json!({})))
}

// ---------------------------------------------------------------- racks

#[derive(Serialize)]
struct RackMeta {
    id: i64,
    name: String,
    version: i64,
    updated_at: String,
    updated_by: String,
}

#[derive(Serialize)]
struct RackFull {
    id: i64,
    name: String,
    version: i64,
    updated_at: String,
    updated_by: String,
    doc: Box<RawValue>,
}

const RACK_SELECT: &str = "SELECT r.id, r.name, r.version, r.updated_at, COALESCE(u.name, '') \
                           FROM racks r LEFT JOIN users u ON u.id = r.updated_by_user_id";

fn row_meta(r: &rusqlite::Row) -> rusqlite::Result<RackMeta> {
    Ok(RackMeta { id: r.get(0)?, name: r.get(1)?, version: r.get(2)?, updated_at: r.get(3)?, updated_by: r.get(4)? })
}

fn get_meta(conn: &Connection, id: i64) -> Result<Option<RackMeta>, ApiError> {
    Ok(conn.query_row(&format!("{RACK_SELECT} WHERE r.id = ?1"), params![id], row_meta).optional()?)
}

fn rack_not_found() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "Rack not found")
}

fn check_doc(raw: &RawValue) -> Result<(), ApiError> {
    serde_json::from_str::<model::Doc>(raw.get())
        .map(|_| ())
        .map_err(|e| ApiError::bad(format!("Invalid rack document: {e}")))
}

async fn list_racks(State(st): State<Shared>, headers: HeaderMap) -> ApiResult {
    auth(&st, &headers)?;
    let conn = st.db();
    let mut stmt = conn.prepare(&format!("{RACK_SELECT} ORDER BY r.updated_at DESC, r.id DESC"))?;
    let rows = stmt.query_map([], row_meta)?.collect::<Result<Vec<RackMeta>, _>>()?;
    Ok(json_ok(&rows))
}

#[derive(Deserialize)]
struct NewRackReq {
    name: String,
    doc: Box<RawValue>,
}

async fn create_rack(State(st): State<Shared>, headers: HeaderMap, body: Bytes) -> ApiResult {
    let me = auth(&st, &headers)?;
    let req: NewRackReq = parse(&body)?;
    let name = norm_name(&req.name)?;
    check_doc(&req.doc)?;
    let conn = st.db();
    conn.execute(
        "INSERT INTO racks (name, doc, version, updated_at, updated_by_user_id) VALUES (?1, ?2, 1, ?3, ?4)",
        params![name, req.doc.get(), now_rfc3339(), me.id],
    )?;
    let meta = get_meta(&conn, conn.last_insert_rowid())?.ok_or_else(rack_not_found)?;
    Ok(json_ok(&meta))
}

async fn get_rack(State(st): State<Shared>, headers: HeaderMap, Path(id): Path<i64>) -> ApiResult {
    auth(&st, &headers)?;
    let conn = st.db();
    let meta = get_meta(&conn, id)?.ok_or_else(rack_not_found)?;
    let text: String = conn.query_row("SELECT doc FROM racks WHERE id = ?1", params![id], |r| r.get(0))?;
    let doc = RawValue::from_string(text)
        .map_err(|_| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "Stored document is corrupt"))?;
    Ok(json_ok(&RackFull {
        id: meta.id,
        name: meta.name,
        version: meta.version,
        updated_at: meta.updated_at,
        updated_by: meta.updated_by,
        doc,
    }))
}

#[derive(Deserialize)]
struct PutRackReq {
    name: String,
    doc: Box<RawValue>,
    version: i64,
}

async fn put_rack(State(st): State<Shared>, headers: HeaderMap, Path(id): Path<i64>, body: Bytes) -> ApiResult {
    let me = auth(&st, &headers)?;
    let req: PutRackReq = parse(&body)?;
    let name = norm_name(&req.name)?;
    check_doc(&req.doc)?;
    let conn = st.db();
    let cur = get_meta(&conn, id)?.ok_or_else(rack_not_found)?;
    if cur.version != req.version {
        return Ok((
            StatusCode::CONFLICT,
            Json(json!({
                "error": "This rack was changed by someone else. Reload to see their changes.",
                "version": cur.version,
                "updated_by": cur.updated_by,
            })),
        )
            .into_response());
    }
    conn.execute(
        "UPDATE racks SET name = ?1, doc = ?2, version = version + 1, updated_at = ?3, updated_by_user_id = ?4 \
         WHERE id = ?5",
        params![name, req.doc.get(), now_rfc3339(), me.id, id],
    )?;
    let meta = get_meta(&conn, id)?.ok_or_else(rack_not_found)?;
    Ok(json_ok(&meta))
}

async fn delete_rack(State(st): State<Shared>, headers: HeaderMap, Path(id): Path<i64>) -> ApiResult {
    auth(&st, &headers)?;
    let n = st.db().execute("DELETE FROM racks WHERE id = ?1", params![id])?;
    if n == 0 {
        return Err(rack_not_found());
    }
    Ok(json_ok(&json!({})))
}

// ---------------------------------------------------------------- compute

#[derive(Deserialize)]
struct RouteReq {
    doc: model::Doc,
    face: String,
}

async fn route_cables(State(st): State<Shared>, headers: HeaderMap, body: Bytes) -> ApiResult {
    auth(&st, &headers)?;
    let req: RouteReq = parse(&body)?;
    Ok(json_ok(&router::route_all(&req.doc, &req.face)))
}

#[derive(Deserialize)]
struct PortsReq {
    doc: model::Doc,
}

async fn port_positions(State(st): State<Shared>, headers: HeaderMap, body: Bytes) -> ApiResult {
    auth(&st, &headers)?;
    let req: PortsReq = parse(&body)?;
    let doc = &req.doc;
    let out: Vec<(i64, f64, f64, f64)> = doc
        .devices
        .iter()
        .flat_map(|d| geom::port_geom(doc, d))
        .map(|(id, p)| (id, p.x, p.y, p.s))
        .collect();
    Ok(json_ok(&out))
}

// ---------------------------------------------------------------- app

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    pw_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS racks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    doc TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL,
    updated_by_user_id INTEGER
);
";

/// Open (creating if needed) the database in `data_dir` and build the full router.
pub fn build_app(data_dir: &FsPath, static_dir: &FsPath) -> Result<Router, String> {
    std::fs::create_dir_all(data_dir).map_err(|e| format!("cannot create data dir {}: {e}", data_dir.display()))?;
    let conn = Connection::open(data_dir.join("rackwright.db")).map_err(|e| format!("cannot open database: {e}"))?;
    conn.execute_batch("PRAGMA journal_mode = WAL;").map_err(|e| format!("database setup failed: {e}"))?;
    conn.execute_batch(SCHEMA).map_err(|e| format!("database setup failed: {e}"))?;

    let state: Shared = Arc::new(AppState { db: Mutex::new(conn) });
    let spa = ServeDir::new(static_dir).fallback(ServeFile::new(static_dir.join("index.html")));

    let app = Router::new()
        .route("/healthz", get(healthz))
        .route("/api/setup", get(get_setup).post(post_setup))
        .route("/api/login", post(post_login))
        .route("/api/logout", post(post_logout))
        .route("/api/me", get(get_me))
        .route("/api/me/password", post(post_me_password))
        .route("/api/users", get(list_users).post(create_user))
        .route("/api/users/:id", axum::routing::patch(patch_user).delete(delete_user))
        .route("/api/racks", get(list_racks).post(create_rack))
        .route("/api/racks/:id", get(get_rack).put(put_rack).delete(delete_rack))
        .route("/api/route_cables", post(route_cables))
        .route("/api/port_positions", post(port_positions))
        .route("/api/*rest", any(api_not_found))
        .fallback_service(spa)
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
        .with_state(state);
    Ok(app)
}

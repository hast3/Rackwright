use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use axum::Router;
use serde_json::{json, Value};
use tower::ServiceExt;

struct Client {
    app: Router,
    cookie: Option<String>,
}

impl Client {
    fn new(app: &Router) -> Self {
        Client { app: app.clone(), cookie: None }
    }

    async fn call(&mut self, method: Method, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
        let mut b = Request::builder().method(method).uri(uri);
        if let Some(c) = &self.cookie {
            b = b.header(header::COOKIE, c.as_str());
        }
        let req = if let Some(v) = body {
            b.header(header::CONTENT_TYPE, "application/json").body(Body::from(v.to_string())).unwrap()
        } else {
            b.body(Body::empty()).unwrap()
        };
        let resp = self.app.clone().oneshot(req).await.unwrap();
        let status = resp.status();
        if let Some(sc) = resp.headers().get(header::SET_COOKIE) {
            let pair = sc.to_str().unwrap().split(';').next().unwrap().to_string();
            if pair.ends_with('=') {
                self.cookie = None;
            } else {
                self.cookie = Some(pair);
            }
        }
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let v = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, v)
    }

    async fn get(&mut self, uri: &str) -> (StatusCode, Value) {
        self.call(Method::GET, uri, None).await
    }
    async fn post(&mut self, uri: &str, body: Value) -> (StatusCode, Value) {
        self.call(Method::POST, uri, Some(body)).await
    }
    async fn put(&mut self, uri: &str, body: Value) -> (StatusCode, Value) {
        self.call(Method::PUT, uri, Some(body)).await
    }
    async fn patch(&mut self, uri: &str, body: Value) -> (StatusCode, Value) {
        self.call(Method::PATCH, uri, Some(body)).await
    }
    async fn delete(&mut self, uri: &str) -> (StatusCode, Value) {
        self.call(Method::DELETE, uri, None).await
    }
}

fn make_app() -> (Router, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let app = rackwright_server::build_app(&dir.path().join("data"), &dir.path().join("static")).unwrap();
    (app, dir)
}

fn sample_doc() -> Value {
    json!({
        "v": 2, "nid": 20,
        "racks": [{"id": 1, "name": "R1", "u": 12, "x": 0, "y": 0}],
        "devices": [
            {"id": 2, "name": "sw", "type": "Switch", "u_size": 1, "rack": 1, "u": 1,
             "ports": [{"id": 3, "name": "1", "type": "RJ45", "label": ""}, {"id": 4, "name": "2", "type": "RJ45", "label": ""}]},
            {"id": 5, "name": "pp", "type": "Patch Panel", "u_size": 1, "rack": 1, "u": 5,
             "ports": [{"id": 6, "name": "1", "type": "RJ45", "label": ""}]}
        ],
        "cables": [{"id": 9, "a": 3, "b": 6, "color": "#ff0000"}],
        "custom_field": "keep me"
    })
}

async fn setup_admin(c: &mut Client) -> Value {
    let (s, v) = c.post("/api/setup", json!({"email": "Admin@Example.com", "name": "Ada", "password": "password1"})).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    v
}

#[tokio::test]
async fn setup_login_me() {
    let (app, _d) = make_app();
    let mut c = Client::new(&app);

    let (s, v) = c.get("/healthz").await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v, Value::Null); // plain text "ok"

    assert_eq!(c.get("/api/setup").await.1, json!({"needs_setup": true}));
    assert_eq!(c.get("/api/me").await.0, StatusCode::UNAUTHORIZED);

    let user = setup_admin(&mut c).await;
    assert_eq!(user["email"], "admin@example.com");
    assert_eq!(user["is_admin"], true);
    assert_eq!(c.get("/api/setup").await.1, json!({"needs_setup": false}));

    // already signed in by setup
    let (s, me) = c.get("/api/me").await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(me, user);

    // second setup refused
    let (s, _) = c.post("/api/setup", json!({"email": "x@y.z", "name": "X", "password": "password1"})).await;
    assert_eq!(s, StatusCode::CONFLICT);

    // logout, then login with different email case
    assert_eq!(c.post("/api/logout", json!({})).await.0, StatusCode::OK);
    assert_eq!(c.get("/api/me").await.0, StatusCode::UNAUTHORIZED);

    let (s, v) = c.post("/api/login", json!({"email": "admin@example.com", "password": "nope"})).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    assert_eq!(v["error"], "Wrong email or password");

    let (s, v) = c.post("/api/login", json!({"email": "ADMIN@example.com", "password": "password1"})).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(c.get("/api/me").await.1["name"], "Ada");

    // password change
    let (s, _) = c.post("/api/me/password", json!({"current": "wrong", "new": "password2"})).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    let (s, _) = c.post("/api/me/password", json!({"current": "password1", "new": "short"})).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    let (s, _) = c.post("/api/me/password", json!({"current": "password1", "new": "password2"})).await;
    assert_eq!(s, StatusCode::OK);
    c.post("/api/logout", json!({})).await;
    let (s, _) = c.post("/api/login", json!({"email": "admin@example.com", "password": "password2"})).await;
    assert_eq!(s, StatusCode::OK);
}

#[tokio::test]
async fn non_admin_forbidden_and_user_management() {
    let (app, _d) = make_app();
    let mut admin = Client::new(&app);
    setup_admin(&mut admin).await;

    let (s, u) = admin
        .post("/api/users", json!({"email": "bob@example.com", "name": "Bob", "password": "bobbobbob", "is_admin": false}))
        .await;
    assert_eq!(s, StatusCode::OK, "{u}");
    let bob_id = u["id"].as_i64().unwrap();
    let (s, _) = admin
        .post("/api/users", json!({"email": "BOB@example.com", "name": "Bob2", "password": "bobbobbob", "is_admin": false}))
        .await;
    assert_eq!(s, StatusCode::CONFLICT);
    assert_eq!(admin.get("/api/users").await.1.as_array().unwrap().len(), 2);

    let mut bob = Client::new(&app);
    let (s, _) = bob.post("/api/login", json!({"email": "bob@example.com", "password": "bobbobbob"})).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(bob.get("/api/users").await.0, StatusCode::FORBIDDEN);
    assert_eq!(bob.post("/api/users", json!({"email": "c@d.e", "name": "C", "password": "12345678"})).await.0, StatusCode::FORBIDDEN);
    assert_eq!(bob.patch("/api/users/1", json!({"name": "Hax"})).await.0, StatusCode::FORBIDDEN);
    assert_eq!(bob.delete("/api/users/1").await.0, StatusCode::FORBIDDEN);
    // unauthenticated
    assert_eq!(Client::new(&app).get("/api/users").await.0, StatusCode::UNAUTHORIZED);

    // admin promotes and renames Bob, resets password
    let (s, v) = admin.patch(&format!("/api/users/{bob_id}"), json!({"name": "Robert", "is_admin": true, "password": "newpassword"})).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["name"], "Robert");
    assert_eq!(v["is_admin"], true);

    // deleting a user removes their sessions
    let (s, _) = admin.delete(&format!("/api/users/{bob_id}")).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(bob.get("/api/me").await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(admin.delete(&format!("/api/users/{bob_id}")).await.0, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn last_admin_protections() {
    let (app, _d) = make_app();
    let mut admin = Client::new(&app);
    let me = setup_admin(&mut admin).await;
    let my_id = me["id"].as_i64().unwrap();

    // cannot delete self
    assert_eq!(admin.delete(&format!("/api/users/{my_id}")).await.0, StatusCode::BAD_REQUEST);
    // cannot demote the last admin
    let (s, v) = admin.patch(&format!("/api/users/{my_id}"), json!({"is_admin": false})).await;
    assert_eq!(s, StatusCode::BAD_REQUEST, "{v}");

    // with a second admin, demoting is fine; the remaining one is protected again
    let (_, u2) = admin
        .post("/api/users", json!({"email": "two@example.com", "name": "Two", "password": "twotwotwo", "is_admin": true}))
        .await;
    let id2 = u2["id"].as_i64().unwrap();
    let (s, _) = admin.patch(&format!("/api/users/{id2}"), json!({"is_admin": false})).await;
    assert_eq!(s, StatusCode::OK);
    let (s, _) = admin.patch(&format!("/api/users/{my_id}"), json!({"is_admin": false})).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    // user 2 is now a plain user and can't be used to delete the admin
    assert_eq!(admin.delete(&format!("/api/users/{id2}")).await.0, StatusCode::OK);
}

#[tokio::test]
async fn racks_crud_and_conflict() {
    let (app, _d) = make_app();
    let mut a = Client::new(&app);
    setup_admin(&mut a).await;

    assert_eq!(Client::new(&app).get("/api/racks").await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(a.get("/api/racks").await.1, json!([]));

    // invalid doc
    let (s, _) = a.post("/api/racks", json!({"name": "bad", "doc": {"racks": "nope"}})).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);

    let (s, meta) = a.post("/api/racks", json!({"name": "Lab", "doc": sample_doc()})).await;
    assert_eq!(s, StatusCode::OK, "{meta}");
    assert_eq!(meta["version"], 1);
    assert_eq!(meta["updated_by"], "Ada");
    let id = meta["id"].as_i64().unwrap();

    let (s, full) = a.get(&format!("/api/racks/{id}")).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(full["name"], "Lab");
    assert_eq!(full["doc"]["custom_field"], "keep me");
    assert_eq!(full["doc"]["devices"].as_array().unwrap().len(), 2);

    assert_eq!(a.get("/api/racks").await.1.as_array().unwrap().len(), 1);

    // second user edits
    a.post("/api/users", json!({"email": "bob@example.com", "name": "Bob", "password": "bobbobbob", "is_admin": false})).await;
    let mut b = Client::new(&app);
    b.post("/api/login", json!({"email": "bob@example.com", "password": "bobbobbob"})).await;

    let mut doc2 = sample_doc();
    doc2["nid"] = json!(21);
    let (s, m2) = b.put(&format!("/api/racks/{id}"), json!({"name": "Lab 2", "doc": doc2, "version": 1})).await;
    assert_eq!(s, StatusCode::OK, "{m2}");
    assert_eq!(m2["version"], 2);
    assert_eq!(m2["updated_by"], "Bob");
    assert_eq!(m2["name"], "Lab 2");

    // stale version -> 409
    let (s, c) = a.put(&format!("/api/racks/{id}"), json!({"name": "Mine", "doc": sample_doc(), "version": 1})).await;
    assert_eq!(s, StatusCode::CONFLICT);
    assert_eq!(c["version"], 2);
    assert_eq!(c["updated_by"], "Bob");
    assert!(c["error"].is_string());

    // missing
    assert_eq!(a.get("/api/racks/9999").await.0, StatusCode::NOT_FOUND);
    assert_eq!(a.put("/api/racks/9999", json!({"name": "x", "doc": sample_doc(), "version": 1})).await.0, StatusCode::NOT_FOUND);

    // delete
    assert_eq!(b.delete(&format!("/api/racks/{id}")).await.0, StatusCode::OK);
    assert_eq!(a.get(&format!("/api/racks/{id}")).await.0, StatusCode::NOT_FOUND);
    assert_eq!(a.delete(&format!("/api/racks/{id}")).await.0, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn compute_endpoints() {
    let (app, _d) = make_app();
    let mut a = Client::new(&app);

    // needs a session
    assert_eq!(a.post("/api/route_cables", json!({"doc": sample_doc(), "face": "front"})).await.0, StatusCode::UNAUTHORIZED);

    setup_admin(&mut a).await;
    let (s, v) = a.post("/api/route_cables", json!({"doc": sample_doc(), "face": "front"})).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert!(v["routes"].is_array());
    assert!(v["hints"].is_array());

    let (s, v) = a.post("/api/port_positions", json!({"doc": sample_doc()})).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    let arr = v.as_array().unwrap();
    assert_eq!(arr.len(), 3);
    assert_eq!(arr[0].as_array().unwrap().len(), 4);

    // bad body -> JSON error
    let (s, v) = a.post("/api/route_cables", json!({"nope": 1})).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert!(v["error"].is_string());

    // unknown API path is a JSON 404, not the SPA index
    let (s, v) = a.get("/api/does-not-exist").await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    assert!(v["error"].is_string());
}

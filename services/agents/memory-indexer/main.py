from flask import Flask, jsonify
import os
app = Flask(__name__)

@app.route("/health")
def health():
    return jsonify(status="ok"), 200

@app.route("/introspect")
def introspect():
    return jsonify(build_sha=os.getenv("GITHUB_SHA", "dev")), 200

@app.route("/ingest", methods=["POST"])
def ingest():
    # TODO: wire actual Supabase insert
    return jsonify(status="ingested"), 200

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", 8080)))

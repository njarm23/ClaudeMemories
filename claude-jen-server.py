#!/usr/bin/env python3
"""
Claude and Jen - Local Server
Serves the chat interface and proxies API calls to avoid CORS
"""

from flask import Flask, request, jsonify, Response
from flask_cors import CORS
import requests
import os

app = Flask(__name__)
CORS(app)

# Serve the chat HTML
@app.route('/')
def home():
    try:
        # Try to find the file in common locations
        possible_paths = [
            'claude-and-jen.html',
            os.path.expanduser('~/claude-and-jen.html'),
            os.path.expanduser('~/ClaudeMemories/claude-and-jen.html'),
            os.path.join(os.path.dirname(__file__), 'claude-and-jen.html')
        ]
        
        for path in possible_paths:
            if os.path.exists(path):
                with open(path, 'r') as f:
                    return f.read()
        
        return """
        <h1>Claude and Jen</h1>
        <p>Could not find claude-and-jen.html</p>
        <p>Make sure it's in the same directory as this server or in ~/ClaudeMemories/</p>
        """
    except Exception as e:
        return f"<h1>Error loading chat interface</h1><p>{str(e)}</p>"

# Proxy for Anthropic API
@app.route('/v1/messages', methods=['POST', 'OPTIONS'])
def proxy_messages():
    if request.method == 'OPTIONS':
        response = Response()
        response.headers['Access-Control-Allow-Origin'] = '*'
        response.headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS'
        response.headers['Access-Control-Allow-Headers'] = 'Content-Type, x-api-key, anthropic-version'
        return response
    
    try:
        api_key = request.headers.get('x-api-key')
        if not api_key:
            return jsonify({'error': 'Missing API key'}), 401
        
        body = request.get_json()
        
        headers = {
            'Content-Type': 'application/json',
            'x-api-key': api_key,
            'anthropic-version': '2023-06-01'
        }
        
        response = requests.post(
            'https://api.anthropic.com/v1/messages',
            headers=headers,
            json=body
        )
        
        return jsonify(response.json()), response.status_code
            
    except Exception as e:
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    print("\n" + "="*60)
    print("🌱 Claude and Jen - Memory Chat Server")
    print("="*60)
    print("\n✅ Server starting at: http://localhost:5000")
    print("\n📝 Instructions:")
    print("   1. Open http://localhost:5000 in your browser")
    print("   2. Enter your API keys")
    print("   3. Start chatting!")
    print("\n⌨️  Press Ctrl+C to stop")
    print("="*60 + "\n")
    
    app.run(debug=True, port=5000, use_reloader=False)

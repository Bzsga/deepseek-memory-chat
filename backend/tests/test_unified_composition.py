"""The real middleware, native API and chat router share one identity/allowance."""
import base64
import httpx
from fastapi.testclient import TestClient

from app import main
from account_fixtures import managed_account
from app.chat import ChatProvider, ImageProvider, build_chat_router
from app.config import Settings


class SyntheticStream(httpx.AsyncByteStream):
    async def __aiter__(self):
        yield b'event: message_stop\ndata: {"type":"message_stop"}\n\n'


def test_native_chat_images_and_large_file_share_one_weekly_ledger(tmp_path, monkeypatch):
    requests = []

    def upstream(request):
        requests.append(request)
        if request.url.path.endswith('/images/generations'):
            return httpx.Response(200, json={'data': [{'b64_json': base64.b64encode(b'\x89PNG\r\n\x1a\nsynthetic').decode()}]})
        if request.url.path.endswith('/files'):
            assert len(request.content) > 65536
            return httpx.Response(200, json={'id': 'file_synthetic_composition'})
        return httpx.Response(200, stream=SyntheticStream(),
                              headers={'Content-Type': 'text/event-stream'})

    monkeypatch.setattr(main, 'build_chat_router', lambda store, **kwargs: build_chat_router(store, **kwargs,
        client_factory=lambda: httpx.AsyncClient(transport=httpx.MockTransport(upstream)),
        provider_loader=lambda: ChatProvider('https://api.deepseek.com', 'deepseek-flash', 'synthetic'),
        image_provider_loader=lambda: ImageProvider('https://image.example', 'synthetic-image', 'synthetic')))
    application = main.create_app(Settings(db_path=str(tmp_path / 'shared.sqlite3'), worker_enabled=False,
        api_enabled=True, api_key='synthetic', user_weekly_limit=5, weekly_limit=50))
    with TestClient(application, base_url='https://digimonlegend.com') as client:
        account = managed_account(application.state.store, "shared_case")
        headers = {'Authorization': 'Bearer ' + account['token'], 'X-Chat-User-Id': account['user']['id'],
                   'Origin': 'https://digimonlegend.com'}
        assert client.get('/admin').status_code == 200
        assert client.get('/chat/api/runtime', headers=headers).json()['weekly_quota']['user_weekly_remaining'] == 5
        assert client.post('/chat/anthropic/v1/messages', headers=headers,
            json={'messages': [{'role': 'user', 'content': 'synthetic'}], 'stream': True}).status_code == 200
        assert client.post('/chat/api/images', headers=headers, json={'prompt': 'synthetic image'}).status_code == 200
        assert client.post('/chat/anthropic/v1/files', headers=headers,
            files={'file': ('synthetic.txt', b'x' * 90000, 'text/plain')}).status_code == 200
        native = client.get('/v1/quota', headers=headers).json()
        browser = client.get('/chat/api/quota', headers=headers).json()
        assert native['user_weekly_remaining'] == browser['user_weekly_remaining'] == 2
        assert native['reset_at'].endswith('+08:00')
        assert len(requests) == 3

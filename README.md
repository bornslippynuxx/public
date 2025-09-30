The configuration for external OAuth providers in Airflow 3.0 with `apache-airflow-providers-fab` is quite similar to Airflow 2.x, but there are some important changes to be aware of.

## Key Changes in Airflow 3.0

In Airflow 3.0, FAB (Flask-AppBuilder) has been moved to a separate provider package (`apache-airflow-providers-fab`), but the OAuth configuration approach remains largely the same.

## Configuration Steps

Here's how to configure external OAuth in Airflow 3.0:

### 1. Install the FAB Provider

```bash
pip install apache-airflow-providers-fab
```

### 2. Configure airflow.cfg

```ini
[webserver]
rbac = True
auth_backend = airflow.providers.fab.auth_manager.fab_auth_manager.FabAuthManager

[fab]
auth_type = AUTH_OAUTH
oauth_providers = [
    {
        'name': 'your_provider',
        'icon': 'fa-circle-o',
        'token_key': 'access_token',
        'remote_app': {
            'client_id': 'YOUR_CLIENT_ID',
            'client_secret': 'YOUR_CLIENT_SECRET',
            'api_base_url': 'https://your-oauth-provider.com/api/',
            'client_kwargs': {
                'scope': 'openid profile email'
            },
            'access_token_url': 'https://your-oauth-provider.com/oauth/token',
            'authorize_url': 'https://your-oauth-provider.com/oauth/authorize',
            'request_token_url': None,
        }
    }
]
```

### 3. Create a Custom Security Manager

You'll likely still need a custom security manager in `webserver_config.py`:

```python
from airflow.providers.fab.auth_manager.security_manager.override import FabAirflowSecurityManagerOverride
from flask_appbuilder.security.manager import AUTH_OAUTH

class CustomSecurityManager(FabAirflowSecurityManagerOverride):
    
    def oauth_user_info(self, provider, response=None):
        """
        Get user info from OAuth provider
        """
        if provider == 'your_provider':
            # Extract user info from your OAuth provider's response
            me = self.appbuilder.sm.oauth_remotes[provider].get('userinfo')
            data = me.json()
            
            return {
                'username': data.get('preferred_username'),
                'email': data.get('email'),
                'first_name': data.get('given_name'),
                'last_name': data.get('family_name'),
                'role_keys': data.get('roles', [])  # Your role mapping
            }

SECURITY_MANAGER_CLASS = CustomSecurityManager
```

### 4. Role Mapping

Map OAuth roles to Airflow roles in your security manager:

```python
def auth_user_oauth(self, userinfo):
    """
    Map OAuth roles to Airflow roles
    """
    user = super().auth_user_oauth(userinfo)
    
    # Custom role mapping logic
    oauth_roles = userinfo.get('role_keys', [])
    airflow_roles = []
    
    if 'admin' in oauth_roles:
        airflow_roles.append(self.find_role('Admin'))
    elif 'viewer' in oauth_roles:
        airflow_roles.append(self.find_role('Viewer'))
    else:
        airflow_roles.append(self.find_role('Public'))
    
    user.roles = airflow_roles
    self.update_user(user)
    
    return user
```

## Important Notes for Airflow 3.0

1. **Provider Package**: Make sure you have the correct version of `apache-airflow-providers-fab` installed that's compatible with Airflow 3.0

2. **Auth Manager**: The auth manager configuration has changed slightly - ensure you're pointing to the FAB auth manager from the provider package

3. **Migration Path**: If migrating from 2.11, your existing OAuth configuration should mostly work, but test thoroughly in a non-production environment first

Would you like me to search for the most current documentation on specific OAuth provider configurations (like Okta, Azure AD, Google, etc.) for Airflow 3.0?

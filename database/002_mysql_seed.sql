-- 企业环境基础角色和管理员账号初始化
USE charge_identity;
INSERT INTO roles (id, name) VALUES
('R001','admin'),('R002','operator'),('R003','repairer'),('R004','user')
ON DUPLICATE KEY UPDATE name=VALUES(name);
INSERT INTO users (id, username, password_hash, display_name, status) VALUES
('U001','admin','REPLACE_WITH_BCRYPT_HASH','系统管理员','active'),
('U002','operator','REPLACE_WITH_BCRYPT_HASH','运营人员','active'),
('U003','repairer','REPLACE_WITH_BCRYPT_HASH','维修人员','active'),
('U004','user','REPLACE_WITH_BCRYPT_HASH','社区用户','active')
ON DUPLICATE KEY UPDATE display_name=VALUES(display_name), status=VALUES(status);
INSERT IGNORE INTO user_roles (user_id, role_id) VALUES
('U001','R001'),('U002','R002'),('U003','R003'),('U004','R004');

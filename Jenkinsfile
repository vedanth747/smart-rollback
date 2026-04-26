pipeline {
    agent any

    options {
        disableConcurrentBuilds()
        skipDefaultCheckout(true)
        timestamps()
    }

    triggers {
        githubPush()
    }

    environment {
        IMAGE_NAME = 'rollback-app'
        IMAGE_TAG = 'v2'
        CONTAINER_NAME = 'rollback_app'
        APP_FILE = 'app_v2.js'
        ROLLBACK_TAG = 'last-good'
        KUBE_CONTEXT = 'minikube'
        KUBE_NAMESPACE = 'default'
        KUBE_DEPLOYMENT = 'rollback-app'
    }

    stages {
        stage('Checkout') {
            steps {
                checkout scm
            }
        }

        stage('Prepare') {
            steps {
                script {
                    def shortSha = env.GIT_COMMIT ? env.GIT_COMMIT.take(7) : "build-${env.BUILD_NUMBER}"
                    env.IMAGE_TAG = shortSha
                }
            }
        }

        stage('Build') {
            steps {
                script {
                    if (isUnix()) {
                        sh '''
                            docker run --rm -v "$WORKSPACE":/app -w /app node:18-alpine \
                                node -e "require('fs').accessSync('app_v2.js')"
                        '''
                    } else {
                        bat '''
                            docker run --rm -v "%WORKSPACE%":/app -w /app node:18-alpine \
                                node -e "require('fs').accessSync('app_v2.js')"
                        '''
                    }
                }
            }
        }

        stage('Docker Build') {
            steps {
                script {
                    if (isUnix()) {
                        sh 'docker build --build-arg APP_FILE=$APP_FILE -t $IMAGE_NAME:$IMAGE_TAG .'
                    } else {
                        bat 'docker build --build-arg APP_FILE=%APP_FILE% -t %IMAGE_NAME%:%IMAGE_TAG% .'
                    }
                }
            }
        }

        stage('Run Container') {
            steps {
                script {
                    if (isUnix()) {
                        sh 'docker rm -f $CONTAINER_NAME || true'
                        sh 'docker run -d -p 3000:3000 --name $CONTAINER_NAME $IMAGE_NAME:$IMAGE_TAG'
                    } else {
                        bat 'docker rm -f %CONTAINER_NAME% >nul 2>&1'
                        bat 'docker run -d -p 3000:3000 --name %CONTAINER_NAME% %IMAGE_NAME%:%IMAGE_TAG%'
                    }
                }
            }
        }

        stage('Smoke Test') {
            steps {
                script {
                    if (isUnix()) {
                        sh 'curl -s http://localhost:3000/status'
                    } else {
                        bat 'curl -s http://localhost:3000/status'
                    }
                }
            }
        }

        stage('Docker Push') {
            when {
                expression {
                    return env.DOCKER_USER?.trim()
                }
            }
            steps {
                script {
                    if (isUnix()) {
                        sh 'echo "$DOCKER_PASS" | docker login -u "$DOCKER_USER" --password-stdin'
                        sh 'docker tag $IMAGE_NAME:$IMAGE_TAG $DOCKER_USER/$IMAGE_NAME:$IMAGE_TAG'
                        sh 'docker push $DOCKER_USER/$IMAGE_NAME:$IMAGE_TAG'
                    } else {
                        bat 'echo %DOCKER_PASS% | docker login -u %DOCKER_USER% --password-stdin'
                        bat 'docker tag %IMAGE_NAME%:%IMAGE_TAG% %DOCKER_USER%/%IMAGE_NAME%:%IMAGE_TAG%'
                        bat 'docker push %DOCKER_USER%/%IMAGE_NAME%:%IMAGE_TAG%'
                    }
                }
            }
        }

        stage('Kubernetes Deploy') {
            when {
                expression {
                    return env.DOCKER_USER?.trim()
                }
            }
            steps {
                script {
                    def imageRef = "${env.DOCKER_USER}/${env.IMAGE_NAME}:${env.IMAGE_TAG}"
                    if (isUnix()) {
                        sh 'kubectl config use-context $KUBE_CONTEXT'
                        sh 'kubectl apply -f Deployment.yaml -n $KUBE_NAMESPACE'
                        sh 'kubectl apply -f Service.yaml -n $KUBE_NAMESPACE'
                        sh "kubectl set image deployment/${env.KUBE_DEPLOYMENT} ${env.KUBE_DEPLOYMENT}=${imageRef} -n ${env.KUBE_NAMESPACE}"
                        sh "kubectl rollout status deployment/${env.KUBE_DEPLOYMENT} -n ${env.KUBE_NAMESPACE}"
                        sh 'kubectl get pods -n $KUBE_NAMESPACE'
                        sh 'kubectl get services -n $KUBE_NAMESPACE'
                    } else {
                        bat 'kubectl config use-context %KUBE_CONTEXT%'
                        bat 'kubectl apply -f Deployment.yaml -n %KUBE_NAMESPACE%'
                        bat 'kubectl apply -f Service.yaml -n %KUBE_NAMESPACE%'
                        bat "kubectl set image deployment/%KUBE_DEPLOYMENT% %KUBE_DEPLOYMENT%=${imageRef} -n %KUBE_NAMESPACE%"
                        bat 'kubectl rollout status deployment/%KUBE_DEPLOYMENT% -n %KUBE_NAMESPACE%'
                        bat 'kubectl get pods -n %KUBE_NAMESPACE%'
                        bat 'kubectl get services -n %KUBE_NAMESPACE%'
                    }
                }
            }
        }
    }

    post {
        success {
            script {
                if (isUnix()) {
                    sh 'docker tag $IMAGE_NAME:$IMAGE_TAG $IMAGE_NAME:$ROLLBACK_TAG'
                } else {
                    bat 'docker tag %IMAGE_NAME%:%IMAGE_TAG% %IMAGE_NAME%:%ROLLBACK_TAG%'
                }
            }
        }

        failure {
            script {
                def hasRollback = 0
                if (isUnix()) {
                    hasRollback = sh(returnStatus: true, script: 'docker image inspect $IMAGE_NAME:$ROLLBACK_TAG >/dev/null 2>&1')
                } else {
                    hasRollback = bat(returnStatus: true, script: 'docker image inspect %IMAGE_NAME%:%ROLLBACK_TAG% >nul 2>&1')
                }

                if (hasRollback == 0) {
                    if (isUnix()) {
                        sh 'docker rm -f $CONTAINER_NAME || true'
                        sh 'docker run -d -p 3000:3000 --name $CONTAINER_NAME $IMAGE_NAME:$ROLLBACK_TAG'
                    } else {
                        bat 'docker rm -f %CONTAINER_NAME% >nul 2>&1'
                        bat 'docker run -d -p 3000:3000 --name %CONTAINER_NAME% %IMAGE_NAME%:%ROLLBACK_TAG%'
                    }
                }

                if (env.DOCKER_USER?.trim()) {
                    if (isUnix()) {
                        sh 'kubectl config use-context $KUBE_CONTEXT'
                        def hasDeploy = sh(returnStatus: true, script: 'kubectl get deployment $KUBE_DEPLOYMENT -n $KUBE_NAMESPACE >/dev/null 2>&1')
                        if (hasDeploy == 0) {
                            sh 'kubectl rollout undo deployment/$KUBE_DEPLOYMENT -n $KUBE_NAMESPACE'
                            sh 'kubectl rollout status deployment/$KUBE_DEPLOYMENT -n $KUBE_NAMESPACE'
                        }
                    } else {
                        bat 'kubectl config use-context %KUBE_CONTEXT%'
                        def hasDeploy = bat(returnStatus: true, script: 'kubectl get deployment %KUBE_DEPLOYMENT% -n %KUBE_NAMESPACE% >nul 2>&1')
                        if (hasDeploy == 0) {
                            bat 'kubectl rollout undo deployment/%KUBE_DEPLOYMENT% -n %KUBE_NAMESPACE%'
                            bat 'kubectl rollout status deployment/%KUBE_DEPLOYMENT% -n %KUBE_NAMESPACE%'
                        }
                    }
                }
            }
        }

        always {
            script {
                if (isUnix()) {
                    sh 'docker ps -a'
                } else {
                    bat 'docker ps -a'
                }
            }
        }
    }
}
